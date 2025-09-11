var device = null;
(function() {
    'use strict';

    function hex4(n) {
        let s = n.toString(16)
        while (s.length < 4) {
            s = '0' + s;
        }
        return s;
    }

    function hexAddr8(n) {
        let s = n.toString(16)
        while (s.length < 8) {
            s = '0' + s;
        }
        return "0x" + s;
    }

    function niceSize(n) {
        const gigabyte = 1024 * 1024 * 1024;
        const megabyte = 1024 * 1024;
        const kilobyte = 1024;
        if (n >= gigabyte) {
            return n / gigabyte + "GiB";
        } else if (n >= megabyte) {
            return n / megabyte + "MiB";
        } else if (n >= kilobyte) {
            return n / kilobyte + "KiB";
        } else {
            return n + "B";
        }
    }

    function formatDFUSummary(device) {
        const vid = hex4(device.device_.vendorId);
        const pid = hex4(device.device_.productId);
        const name = device.device_.productName;

        let mode = "Unknown"
        if (device.settings.alternate.interfaceProtocol == 0x01) {
            mode = "Runtime";
        } else if (device.settings.alternate.interfaceProtocol == 0x02) {
            mode = "DFU";
        }

        const cfg = device.settings.configuration.configurationValue;
        const intf = device.settings["interface"].interfaceNumber;
        const alt = device.settings.alternate.alternateSetting;
        const serial = device.device_.serialNumber;
        let info = `${mode}: [${vid}:${pid}] cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}" serial="${serial}"`;
        return info;
    }

    function formatDFUInterfaceAlternate(settings) {
        let mode = "Unknown"
        if (settings.alternate.interfaceProtocol == 0x01) {
            mode = "Runtime";
        } else if (settings.alternate.interfaceProtocol == 0x02) {
            mode = "DFU";
        }

        const cfg = settings.configuration.configurationValue;
        const intf = settings["interface"].interfaceNumber;
        const alt = settings.alternate.alternateSetting;
        const name = (settings.name) ? settings.name : "UNKNOWN";

        return `${mode}: cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}"`;
    }

    async function fixInterfaceNames(device_, interfaces) {
        if (interfaces.some(intf => (intf.name == null))) {
            let tempDevice = new dfu.Device(device_, interfaces[0]);
            await tempDevice.device_.open();
            await tempDevice.device_.selectConfiguration(1);
            let mapping = await tempDevice.readInterfaceNames();
            await tempDevice.close();

            for (let intf of interfaces) {
                if (intf.name === null) {
                    let configIndex = intf.configuration.configurationValue;
                    let intfNumber = intf["interface"].interfaceNumber;
                    let alt = intf.alternate.alternateSetting;
                    intf.name = mapping[configIndex][intfNumber][alt];
                }
            }
        }
    }

    function populateInterfaceList(form, device_, interfaces) {
        let old_choices = Array.from(form.querySelectorAll("label.radio"));
        for (let radio_div of old_choices) {
            form.removeChild(radio_div);
        }

        let buttonContainer = form.querySelector(".d-flex");

        for (let i=0; i < interfaces.length; i++) {
            let radio = document.createElement("input");
            radio.type = "radio";
            radio.name = "interfaceIndex";
            radio.value = i;
            radio.id = "interface" + i;
            radio.required = true;

            let label = document.createElement("label");
            label.textContent = formatDFUInterfaceAlternate(interfaces[i]);
            label.className = "radio"
            label.setAttribute("for", "interface" + i);
            label.prepend(radio);

            form.insertBefore(label, buttonContainer);
        }
    }

    function getDFUDescriptorProperties(device) {
        return device.readConfigurationDescriptor(0).then(
            data => {
                let configDesc = dfu.parseConfigurationDescriptor(data);
                let funcDesc = null;
                let configValue = device.settings.configuration.configurationValue;
                if (configDesc.bConfigurationValue == configValue) {
                    for (let desc of configDesc.descriptors) {
                        if (desc.bDescriptorType == 0x21 && desc.hasOwnProperty("bcdDFUVersion")) {
                            funcDesc = desc;
                            break;
                        }
                    }
                }

                if (funcDesc) {
                    return {
                        WillDetach:            ((funcDesc.bmAttributes & 0x08) != 0),
                        ManifestationTolerant: ((funcDesc.bmAttributes & 0x04) != 0),
                        CanUpload:             ((funcDesc.bmAttributes & 0x02) != 0),
                        CanDnload:             ((funcDesc.bmAttributes & 0x01) != 0),
                        TransferSize:          funcDesc.wTransferSize,
                        DetachTimeOut:         funcDesc.wDetachTimeOut,
                        DFUVersion:            funcDesc.bcdDFUVersion
                    };
                } else {
                    return {};
                }
            },
            error => {}
        );
    }

    let logContext = null;
    let downloadProgress;

    function setLogContext(div) {
        logContext = div;
    };

    function clearLog(context) {
        if (typeof context === 'undefined') {
            context = logContext;
        }
        if (context) {
            if (context.tagName.toLowerCase() === "textarea") {
                context.value = "";
            } else {
                context.innerHTML = "";
            }
        }
        if (downloadProgress) {
            downloadProgress.value = 0;
            downloadProgress.setAttribute("hidden", "true");
        }
    }

    function logDebug(msg) {
        console.log(msg);
        if (logContext) {
            logContext.value += `${msg}\n`;
            logContext.scrollTop = logContext.scrollHeight;
        }
    }

    function logInfo(msg) {
        if (logContext) {
            logContext.value += `[INFO] ${msg}\n`;
            logContext.scrollTop = logContext.scrollHeight;
        }
    }

    function logWarning(msg) {
        if (logContext) {
            logContext.value += `[WARN] ${msg}\n`;
            logContext.scrollTop = logContext.scrollHeight;
        }
    }

    function logError(msg) {
        if (logContext) {
            logContext.value += `[ERROR] ${msg}\n`;
            logContext.scrollTop = logContext.scrollHeight;
        }
    }

    function logProgress(done, total) {
        if (downloadProgress) {
            if (downloadProgress.hasAttribute("hidden")) {
                downloadProgress.removeAttribute("hidden");
            }
            downloadProgress.value = done;
            if (typeof total !== 'undefined') {
                downloadProgress.max = total;
            }
        }
    }

    function processSegments(segments) {
        if (segments.length === 0) {
            return {
                data: new ArrayBuffer(0),
                startAddress: 0
            };
        }

        segments.sort((a, b) => a.address - b.address);

        const minAddr = segments[0].address;
        let maxAddr = 0;

        for (const seg of segments) {
            const endAddr = seg.address + seg.data.length;
            if (endAddr > maxAddr) {
                maxAddr = endAddr;
            }
        }

        const totalSize = maxAddr - minAddr;
        const binary = new Uint8Array(totalSize);
        binary.fill(0xFF);

        for (const seg of segments) {
            binary.set(seg.data, seg.address - minAddr);
        }

        return {
            data: binary.buffer,
            startAddress: minAddr
        };
    }

    function parseIntelHex(hex) {
        const lines = hex.split(/\r?\n/);
        let extendedLinearAddress = 0;
        const segments = [];

        for (const line of lines) {
            if (!line.startsWith(':') || line.length < 11) continue;

            const byteCount = parseInt(line.substring(1, 3), 16);
            if (line.length < 11 + byteCount * 2) continue;

            const address = parseInt(line.substring(3, 7), 16);
            const recordType = parseInt(line.substring(7, 9), 16);

            const dataBytes = [];
            let calculatedChecksum = byteCount + (address >> 8) + (address & 0xFF) + recordType;

            for (let i = 0; i < byteCount; i++) {
                const byte = parseInt(line.substring(9 + i * 2, 11 + i * 2), 16);
                dataBytes.push(byte);
                calculatedChecksum += byte;
            }

            const providedChecksum = parseInt(line.substring(9 + byteCount * 2, 11 + byteCount * 2), 16);
            calculatedChecksum = (0x100 - (calculatedChecksum & 0xFF)) & 0xFF;

            if (calculatedChecksum !== providedChecksum) {
                throw new Error(`Checksum mismatch on line: ${line}`);
            }

            switch (recordType) {
                case 0x00:
                    const fullAddress = (extendedLinearAddress << 16) | address;
                    segments.push({ address: fullAddress, data: new Uint8Array(dataBytes) });
                    break;
                case 0x01:
                    return processSegments(segments);
                case 0x02:
                    console.warn("Ignoring Extended Segment Address Record (02)");
                    break;
                case 0x03:
                    break;
                case 0x04:
                    extendedLinearAddress = (dataBytes[0] << 8) | dataBytes[1];
                    break;
                case 0x05:
                    break;
                default:
                    console.warn(`Unknown record type: ${recordType}`);
                    break;
            }
        }

        return processSegments(segments);
    }

    document.addEventListener('DOMContentLoaded', event => {
        let connectButton = document.querySelector("#connect");
        let detachButton = document.querySelector("#detach");
        let downloadButton = document.querySelector("#download");
        let statusDisplay = document.querySelector("#status");
        let infoDisplay = document.querySelector("#usbInfo");
        let dfuDisplay = document.querySelector("#dfuInfo");
        let interfaceDialog = document.querySelector("#interfaceDialog");
        let interfaceForm = document.querySelector("#interfaceForm");

        let searchParams = new URLSearchParams(window.location.search);
        let fromLandingPage = false;

        let serial = "";
        if (searchParams.has("serial")) {
            serial = searchParams.get("serial");
            if (window.location.search.endsWith("/") && serial.endsWith("/")) {
                serial = serial.substring(0, serial.length-1);
            }
            fromLandingPage = true;
        }

        let configForm = document.querySelector("#configForm");
        let transferSizeField = document.querySelector("#transferSize");
        let transferSize = parseInt(transferSizeField.value);

        let dfuseFieldsDiv = document.querySelector("#dfuseFields");
        let dfuseStartAddressField = document.querySelector("#dfuseStartAddress");
        dfuseFieldsDiv.hidden = true;

        let firmwareFileField = document.querySelector("#firmwareFile");
        let firmwareFile = null;
        firmwareFileField.disabled = false;

        let downloadLog = document.querySelector("#downloadLog");
        downloadProgress = document.querySelector("#downloadProgress");

        let manifestationTolerant = true;
        let isDeviceReady = false;
        let isFirmwareLoaded = false;

        function updateFlashButtonState() {
            if (isDeviceReady && isFirmwareLoaded) {
                downloadButton.disabled = false;
            } else {
                downloadButton.disabled = true;
            }
        }

        function onDisconnect(reason) {
            if (reason) {
                statusDisplay.textContent = reason;
            } else {
                statusDisplay.textContent = "Disconnected";
            }

            isDeviceReady = false;
            updateFlashButtonState();

            connectButton.innerHTML = `<i class="bi bi-usb-drive-fill"></i> Select DFU device`;
            connectButton.classList.remove('btn-danger');
            connectButton.classList.add('btn-primary');

            infoDisplay.textContent = "Not connected";
            dfuDisplay.textContent = "";
            detachButton.style.display = 'none';
            dfuseFieldsDiv.hidden = true;
        }

        function onUnexpectedDisconnect(event) {
            if (device !== null && device.device_ !== null) {
                if (device.device_ === event.device) {
                    device.disconnected = true;
                    onDisconnect("Device disconnected");
                    device = null;
                }
            }
        }

        async function connect(newDevice) {
            device = newDevice;
            try {
                await device.open();
            } catch (error) {
                onDisconnect(error);
                throw error;
            }

            let desc = {};
            try {
                desc = await getDFUDescriptorProperties(device);
            } catch (error) {
                onDisconnect(error);
                throw error;
            }

            let memorySummary = "";
            if (desc && Object.keys(desc).length > 0) {
                device.properties = desc;
                let info = `WillDetach=${desc.WillDetach}, ManifestationTolerant=${desc.ManifestationTolerant}, CanUpload=${desc.CanUpload}, CanDnload=${desc.CanDnload}, TransferSize=${desc.TransferSize}, DetachTimeOut=${desc.DetachTimeOut}, Version=${hex4(desc.DFUVersion)}`;
                dfuDisplay.textContent = info;
                transferSizeField.value = desc.TransferSize;
                transferSize = desc.TransferSize;
                if (desc.CanDnload) {
                    manifestationTolerant = desc.ManifestationTolerant;
                }

                if (device.settings.alternate.interfaceProtocol == 0x02 && desc.CanDnload) {
                    isDeviceReady = true;
                    detachButton.style.display = 'none';
                } else {
                    isDeviceReady = false;
                    if (device.settings.alternate.interfaceProtocol == 0x01) {
                       detachButton.style.display = 'inline-block';
                    } else {
                       detachButton.style.display = 'none';
                    }
                }
                updateFlashButtonState();

                if (desc.DFUVersion == 0x011a && device.settings.alternate.interfaceProtocol == 0x02) {
                    device = new dfuse.Device(device.device_, device.settings);
                    if (device.memoryInfo) {
                        let totalSize = 0;
                        for (let segment of device.memoryInfo.segments) {
                            totalSize += segment.end - segment.start;
                        }
                        memorySummary = `Selected memory region: ${device.memoryInfo.name} (${niceSize(totalSize)})`;
                        for (let segment of device.memoryInfo.segments) {
                            let properties = [];
                            if (segment.readable) { properties.push("readable"); }
                            if (segment.erasable) { properties.push("erasable"); }
                            if (segment.writable) { properties.push("writable"); }
                            let propertySummary = properties.join(", ") || "inaccessible";
                            memorySummary += `\n${hexAddr8(segment.start)}-${hexAddr8(segment.end-1)} (${propertySummary})`;
                        }
                    }
                }
            }

            device.logDebug = logDebug;
            device.logInfo = logInfo;
            device.logWarning = logWarning;
            device.logError = logError;
            device.logProgress = logProgress;

            clearLog(downloadLog);

            statusDisplay.textContent = `Connected to ${device.device_.productName || "Untitled Device"}`;

            connectButton.innerHTML = `<i class="bi bi-x-circle-fill"></i> Disconnect`;
            connectButton.classList.remove('btn-primary');
            connectButton.classList.add('btn-danger');

            infoDisplay.textContent = (
                `Name: ${device.device_.productName || "N/A"}\n` +
                `MFG: ${device.device_.manufacturerName || "N/A"}\n` +
                `Serial: ${device.device_.serialNumber || "N/A"}\n` +
                formatDFUSummary(device) + "\n" + memorySummary
            );

            if (device.memoryInfo) {
                dfuseFieldsDiv.hidden = false;
                dfuseStartAddressField.disabled = false;
                let segment = device.getFirstWritableSegment();
                if (segment) {
                    device.startAddress = segment.start;
                    dfuseStartAddressField.value = "0x" + segment.start.toString(16);
                }
            } else {
                dfuseFieldsDiv.hidden = true;
                dfuseStartAddressField.disabled = true;
            }
        }

        function autoConnect(serial) {
            if (!serial) return;
            dfu.findAllDfuInterfaces().then(
                async dfu_devices => {
                    let matching_devices = dfu_devices.filter(d => d.device_.serialNumber == serial);
                    if (matching_devices.length == 1) {
                        statusDisplay.textContent = 'Auto-connecting...';
                        await connect(matching_devices[0]);
                    } else if (matching_devices.length > 1) {
                        statusDisplay.textContent = "Multiple matching DFU interfaces found.";
                    }
                }
            );
        }

        transferSizeField.addEventListener("change", function() {
            transferSize = parseInt(transferSizeField.value);
        });

        dfuseStartAddressField.addEventListener("change", function(event) {
            const field = event.target;
            let address = parseInt(field.value, 16);
            if (isNaN(address)) {
                field.setCustomValidity("Invalid hexadecimal start address");
            } else if (device && device.memoryInfo) {
                if (device.getSegment(address) !== null) {
                    device.startAddress = address;
                    field.setCustomValidity("");
                } else {
                    field.setCustomValidity("Address outside of memory map");
                }
            } else {
                field.setCustomValidity("");
            }
        });

        connectButton.addEventListener('click', function() {
            if (device) {
                device.close().then(onDisconnect);
                device = null;
            } else {
                let filters = serial ? [{ 'serialNumber': serial }] : [];
                navigator.usb.requestDevice({ 'filters': filters }).then(
                    async selectedDevice => {
                        let interfaces = dfu.findDeviceDfuInterfaces(selectedDevice);
                        await fixInterfaceNames(selectedDevice, interfaces);

                        if (interfaces.length == 0) {
                            statusDisplay.textContent = "The selected device does not have any USB DFU interfaces.";
                        } else if (interfaces.length == 1) {
                            await connect(new dfu.Device(selectedDevice, interfaces[0]));
                        } else {
                            let internalFlashInterfaces = interfaces.filter(intf => intf.name && intf.name.includes("Internal Flash"));
                            if (internalFlashInterfaces.length === 1) {
                                logInfo("Found unique Internal Flash interface, selecting automatically.");
                                await connect(new dfu.Device(selectedDevice, internalFlashInterfaces[0]));
                            } else {
                                populateInterfaceList(interfaceForm, selectedDevice, interfaces);
                                async function connectToSelectedInterface(event) {
                                    event.preventDefault();
                                    interfaceForm.removeEventListener('submit', connectToSelectedInterface);
                                    const index = interfaceForm.elements["interfaceIndex"].value;
                                    await connect(new dfu.Device(selectedDevice, interfaces[index]));
                                    interfaceDialog.close();
                                }
                                interfaceForm.addEventListener('submit', connectToSelectedInterface);
                                interfaceDialog.addEventListener('cancel', () => {
                                    interfaceForm.removeEventListener('submit', connectToSelectedInterface);
                                }, { once: true });
                                interfaceDialog.showModal();
                            }
                        }
                    }
                ).catch(error => {
                    statusDisplay.textContent = `Error: ${error.message}`;
                });
            }
        });

        detachButton.addEventListener('click', function() {
            if (device) {
                device.detach().then(
                    async () => {
                        await device.close();
                        onDisconnect();
                        device = null;
                    },
                    async error => {
                        await device.close();
                        onDisconnect(error);
                        device = null;
                    }
                );
            }
        });

        firmwareFileField.addEventListener("click", function() {
            this.value = null;
        });

        firmwareFileField.addEventListener("change", function() {
            firmwareFile = null;
            isFirmwareLoaded = false;

            if (firmwareFileField.files.length > 0) {
                let file = firmwareFileField.files[0];
                let reader = new FileReader();
                setLogContext(downloadLog);
                clearLog(downloadLog);

                // --- MODIFIED: Get lastModified from file object ---
                const lastModified = file.lastModified;

                if (file.name.toLowerCase().endsWith(".hex")) {
                    reader.onload = function() {
                        try {
                            const result = parseIntelHex(reader.result);
                            firmwareFile = result.data;
                            logInfo(`Parsed ${file.name}, Start Address: 0x${result.startAddress.toString(16)}, Size: ${firmwareFile.byteLength} bytes`);
                            if (device && device.memoryInfo) {
                               dfuseStartAddressField.value = "0x" + result.startAddress.toString(16);
                               dfuseStartAddressField.dispatchEvent(new Event('change'));
                            }
                            const event = new CustomEvent('firmware:info', {
                                detail: {
                                    fileSize: firmwareFile.byteLength,
                                    startAddress: result.startAddress,
                                    lastModified: lastModified
                                }
                            });
                            firmwareFileField.dispatchEvent(event);
                            isFirmwareLoaded = true;
                        } catch (e) {
                            logError(`Error parsing HEX file: ${e.message}`);
                            firmwareFile = null;
                            isFirmwareLoaded = false;
                            firmwareFileField.dispatchEvent(new CustomEvent('firmware:info', { detail: {} }));
                        } finally {
                            updateFlashButtonState();
                        }
                    };
                    reader.readAsText(file);
                } else { // Assume .bin
                    reader.onload = function() {
                        firmwareFile = reader.result;
                        logInfo(`Loaded BIN file: ${file.name}, Size: ${firmwareFile.byteLength} bytes`);
                        const event = new CustomEvent('firmware:info', {
                            detail: {
                                fileSize: firmwareFile.byteLength,
                                startAddress: null,
                                lastModified: lastModified
                            }
                        });
                        firmwareFileField.dispatchEvent(event);
                        isFirmwareLoaded = true;
                        updateFlashButtonState();
                    };
                    reader.readAsArrayBuffer(file);
                }
            } else {
                updateFlashButtonState();
                firmwareFileField.dispatchEvent(new CustomEvent('firmware:info', { detail: {} }));
            }
        });

        downloadButton.addEventListener('click', async function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (!configForm.checkValidity()) {
                configForm.reportValidity();
                return false;
            }

            if (device && firmwareFile != null) {
                downloadButton.disabled = true;
                downloadButton.innerHTML = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Flashing...`;

                try {
                    setLogContext(downloadLog);
                    try {
                        let status = await device.getStatus();
                        if (status.state == dfu.dfuERROR) {
                            await device.clearStatus();
                        }
                    } catch (error) {
                        device.logWarning("Failed to clear status");
                    }
                    await device.do_download(transferSize, firmwareFile, manifestationTolerant);
                    logInfo("Done!");
                    if (!manifestationTolerant) {
                        await device.waitDisconnected(5000);
                        onDisconnect();
                        device = null;
                    }
                } catch (error) {
                    logError(error);
                } finally {
                    downloadButton.innerHTML = `<i class="bi bi-hdd-fill"></i> Flash Firmware`;
                    updateFlashButtonState();
                }
            }
        });

        if (typeof navigator.usb !== 'undefined') {
            navigator.usb.addEventListener("disconnect", onUnexpectedDisconnect);
            if (fromLandingPage) {
                autoConnect(serial);
            }
        } else {
            statusDisplay.textContent = 'WebUSB not available.'
            connectButton.disabled = true;
        }
    });
})();
