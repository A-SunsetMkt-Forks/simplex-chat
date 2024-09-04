"use strict";
// Inspired by
// https://github.com/webrtc/samples/blob/gh-pages/src/content/insertable-streams/endtoend-encryption
var CallMediaType;
(function (CallMediaType) {
    CallMediaType["Audio"] = "audio";
    CallMediaType["Video"] = "video";
})(CallMediaType || (CallMediaType = {}));
var CallMediaSource;
(function (CallMediaSource) {
    CallMediaSource["Mic"] = "mic";
    CallMediaSource["Camera"] = "camera";
    CallMediaSource["ScreenAudio"] = "screenAudio";
    CallMediaSource["ScreenVideo"] = "screenVideo";
    CallMediaSource["Unknown"] = "unknown";
})(CallMediaSource || (CallMediaSource = {}));
var VideoCamera;
(function (VideoCamera) {
    VideoCamera["User"] = "user";
    VideoCamera["Environment"] = "environment";
})(VideoCamera || (VideoCamera = {}));
var LayoutType;
(function (LayoutType) {
    LayoutType["Default"] = "default";
    LayoutType["LocalVideo"] = "localVideo";
    LayoutType["RemoteVideo"] = "remoteVideo";
})(LayoutType || (LayoutType = {}));
// for debugging
// var sendMessageToNative = ({resp}: WVApiMessage) => console.log(JSON.stringify({command: resp}))
var sendMessageToNative = (msg) => console.log(JSON.stringify(msg));
var toggleScreenShare = async () => { };
var localOrPeerMediaSourcesChanged = (_call) => { };
// Global object with cryptrographic/encoding functions
const callCrypto = callCryptoFunction();
var TransformOperation;
(function (TransformOperation) {
    TransformOperation["Encrypt"] = "encrypt";
    TransformOperation["Decrypt"] = "decrypt";
})(TransformOperation || (TransformOperation = {}));
function localMedia(call) {
    return call.localMediaSources.camera || call.localMediaSources.screenVideo ? CallMediaType.Video : CallMediaType.Audio;
}
function peerMedia(call) {
    return call.peerMediaSources.camera || call.peerMediaSources.screenVideo ? CallMediaType.Video : CallMediaType.Audio;
}
let activeCall;
let answerTimeout = 30000;
var useWorker = false;
var isDesktop = false;
var localizedState = "";
var localizedDescription = "";
// Passing true here will send audio in screen record stream
const allowSendScreenAudio = false;
// When one side of a call sends candidates tot fast (until local & remote descriptions are set), that candidates
// will be stored here and then set when the call will be ready to process them
var afterCallInitializedCandidates = [];
const processCommand = (function () {
    const defaultIceServers = [
        { urls: ["stuns:stun.simplex.im:443"] },
        { urls: ["stun:stun.simplex.im:443"] },
        //{urls: ["turns:turn.simplex.im:443?transport=udp"], username: "private2", credential: "Hxuq2QxUjnhj96Zq2r4HjqHRj"},
        { urls: ["turns:turn.simplex.im:443?transport=tcp"], username: "private2", credential: "Hxuq2QxUjnhj96Zq2r4HjqHRj" },
    ];
    function getCallConfig(encodedInsertableStreams, iceServers, relay) {
        return {
            peerConnectionConfig: {
                iceServers: iceServers !== null && iceServers !== void 0 ? iceServers : defaultIceServers,
                iceCandidatePoolSize: 10,
                encodedInsertableStreams,
                iceTransportPolicy: relay ? "relay" : "all",
            },
            iceCandidates: {
                delay: 750,
                extrasInterval: 1500,
                extrasTimeout: 12000,
            },
        };
    }
    function getIceCandidates(conn, config) {
        return new Promise((resolve, _) => {
            let candidates = [];
            let resolved = false;
            let extrasInterval;
            let extrasTimeout;
            const delay = setTimeout(() => {
                if (!resolved) {
                    resolveIceCandidates();
                    extrasInterval = setInterval(() => {
                        sendIceCandidates();
                    }, config.iceCandidates.extrasInterval);
                    extrasTimeout = setTimeout(() => {
                        clearInterval(extrasInterval);
                        sendIceCandidates();
                    }, config.iceCandidates.extrasTimeout);
                }
            }, config.iceCandidates.delay);
            conn.onicecandidate = ({ candidate: c }) => c && candidates.push(c);
            conn.onicegatheringstatechange = () => {
                if (conn.iceGatheringState == "complete") {
                    if (resolved) {
                        if (extrasInterval)
                            clearInterval(extrasInterval);
                        if (extrasTimeout)
                            clearTimeout(extrasTimeout);
                        sendIceCandidates();
                    }
                    else {
                        resolveIceCandidates();
                    }
                }
            };
            function resolveIceCandidates() {
                if (delay)
                    clearTimeout(delay);
                resolved = true;
                // console.log("resolveIceCandidates", JSON.stringify(candidates))
                console.log("resolveIceCandidates");
                const iceCandidates = serialize(candidates);
                candidates = [];
                resolve(iceCandidates);
            }
            function sendIceCandidates() {
                if (candidates.length === 0)
                    return;
                // console.log("sendIceCandidates", JSON.stringify(candidates))
                console.log("sendIceCandidates");
                const iceCandidates = serialize(candidates);
                candidates = [];
                sendMessageToNative({ resp: { type: "ice", iceCandidates } });
            }
        });
    }
    async function initializeCall(config, mediaType, aesKey) {
        var _a;
        let pc;
        try {
            pc = new RTCPeerConnection(config.peerConnectionConfig);
        }
        catch (e) {
            console.log("Error while constructing RTCPeerConnection, will try without 'stuns' specified: " + e);
            const withoutStuns = (_a = config.peerConnectionConfig.iceServers) === null || _a === void 0 ? void 0 : _a.filter((elem) => typeof elem.urls === "string" ? !elem.urls.startsWith("stuns:") : !elem.urls.some((url) => url.startsWith("stuns:")));
            config.peerConnectionConfig.iceServers = withoutStuns;
            pc = new RTCPeerConnection(config.peerConnectionConfig);
        }
        const remoteStream = new MediaStream();
        const remoteScreenStream = new MediaStream();
        const localCamera = VideoCamera.User;
        let localStream;
        // Mic can be disabled while in call if a user didn't give permission to use it, it's fine
        let micEnabled = false;
        try {
            localStream = await getLocalMediaStream(mediaType, localCamera);
            micEnabled = true;
        }
        catch (e) {
            console.log("Error while getting local media stream", e);
            if (isDesktop) {
                desktopShowPermissionsAlert(mediaType);
                localStream = getEmptyStream(mediaType, pc);
            }
            else {
                // On Android all streams should be present
                throw e;
            }
        }
        const localScreenStream = new MediaStream();
        if (isDesktop) {
            localStream
                .getTracks()
                .filter((elem) => elem.kind == "video")
                .forEach((elem) => (elem.enabled = false));
        }
        // Will become video when any video tracks will be added
        const iceCandidates = getIceCandidates(pc, config);
        const call = {
            connection: pc,
            iceCandidates,
            localMediaSources: {
                mic: micEnabled,
                camera: mediaType == CallMediaType.Video && !isDesktop,
                screenAudio: false,
                screenVideo: false,
            },
            localCamera,
            localStream,
            localScreenStream,
            remoteStream,
            remoteScreenStream,
            peerMediaSources: {
                mic: false,
                camera: false,
                screenAudio: false,
                screenVideo: false,
            },
            aesKey,
            cameraTrackWasSetBefore: mediaType == CallMediaType.Video,
            screenShareWasSetupBefore: false,
        };
        localOrPeerMediaSourcesChanged(call);
        await setupMediaStreams(call);
        let connectionTimeout = setTimeout(connectionHandler, answerTimeout);
        pc.addEventListener("connectionstatechange", connectionStateChange);
        return call;
        async function connectionStateChange() {
            // "failed" means the second party did not answer in time (15 sec timeout in Chrome WebView)
            // See https://source.chromium.org/chromium/chromium/src/+/main:third_party/webrtc/p2p/base/p2p_constants.cc;l=70)
            if (pc.connectionState !== "failed")
                connectionHandler();
        }
        async function connectionHandler() {
            sendMessageToNative({
                resp: {
                    type: "connection",
                    state: {
                        connectionState: pc.connectionState,
                        iceConnectionState: pc.iceConnectionState,
                        iceGatheringState: pc.iceGatheringState,
                        signalingState: pc.signalingState,
                    },
                },
            });
            if (pc.connectionState == "disconnected" || pc.connectionState == "failed") {
                clearConnectionTimeout();
                pc.removeEventListener("connectionstatechange", connectionStateChange);
                if (activeCall) {
                    setTimeout(() => sendMessageToNative({ resp: { type: "ended" } }), 0);
                }
                endCall();
            }
            else if (pc.connectionState == "connected") {
                clearConnectionTimeout();
                const stats = (await pc.getStats());
                for (const stat of stats.values()) {
                    const { type, state } = stat;
                    if (type === "candidate-pair" && state === "succeeded") {
                        const iceCandidatePair = stat;
                        const resp = {
                            type: "connected",
                            connectionInfo: {
                                iceCandidatePair,
                                localCandidate: stats.get(iceCandidatePair.localCandidateId),
                                remoteCandidate: stats.get(iceCandidatePair.remoteCandidateId),
                            },
                        };
                        setTimeout(() => sendMessageToNative({ resp }), 500);
                        break;
                    }
                }
            }
        }
        function clearConnectionTimeout() {
            if (connectionTimeout) {
                clearTimeout(connectionTimeout);
                connectionTimeout = undefined;
            }
        }
    }
    function serialize(x) {
        return LZString.compressToBase64(JSON.stringify(x));
    }
    function parse(s) {
        return JSON.parse(LZString.decompressFromBase64(s));
    }
    async function processCommand(body) {
        const { corrId, command } = body;
        const pc = activeCall === null || activeCall === void 0 ? void 0 : activeCall.connection;
        let resp;
        try {
            switch (command.type) {
                case "capabilities":
                    console.log("starting outgoing call - capabilities");
                    if (activeCall)
                        endCall();
                    // This request for local media stream is made to prompt for camera/mic permissions on call start
                    if (command.media) {
                        try {
                            await getLocalMediaStream(command.media, VideoCamera.User);
                        }
                        catch (e) {
                            // Will be shown on the next stage of call estabilishing, can work without any streams
                            //desktopShowPermissionsAlert(command.media)
                        }
                    }
                    const encryption = supportsInsertableStreams(useWorker);
                    resp = { type: "capabilities", capabilities: { encryption } };
                    break;
                case "start": {
                    console.log("starting incoming call - create webrtc session");
                    if (activeCall)
                        endCall();
                    const { media, iceServers, relay } = command;
                    const encryption = supportsInsertableStreams(useWorker);
                    const aesKey = encryption ? command.aesKey : undefined;
                    activeCall = await initializeCall(getCallConfig(encryption && !!aesKey, iceServers, relay), media, aesKey);
                    const pc = activeCall.connection;
                    if (media == CallMediaType.Audio) {
                        console.log("LALAL ADDING TRANSCEIVER for video");
                        // For camera. The first video in the list is for camera
                        pc.addTransceiver("video", { streams: [activeCall.localStream] });
                    }
                    // For screenshare. So the second audio and video in the list is for screenshare
                    pc.addTransceiver("audio", { streams: [activeCall.localScreenStream] });
                    pc.addTransceiver("video", { streams: [activeCall.localScreenStream] });
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    addIceCandidates(pc, afterCallInitializedCandidates);
                    afterCallInitializedCandidates = [];
                    // for debugging, returning the command for callee to use
                    // resp = {
                    //   type: "offer",
                    //   offer: serialize(offer),
                    //   iceCandidates: await activeCall.iceCandidates,
                    //   capabilities: {encryption},
                    //   media,
                    //   iceServers,
                    //   relay,
                    //   aesKey,
                    // }
                    resp = {
                        type: "offer",
                        offer: serialize(offer),
                        iceCandidates: await activeCall.iceCandidates,
                        capabilities: { encryption },
                    };
                    // console.log("offer response", JSON.stringify(resp))
                    break;
                }
                case "offer":
                    if (activeCall) {
                        resp = { type: "error", message: "accept: call already started" };
                    }
                    else if (!supportsInsertableStreams(useWorker) && command.aesKey) {
                        resp = { type: "error", message: "accept: encryption is not supported" };
                    }
                    else {
                        const offer = parse(command.offer);
                        const remoteIceCandidates = parse(command.iceCandidates);
                        const { media, aesKey, iceServers, relay } = command;
                        activeCall = await initializeCall(getCallConfig(!!aesKey, iceServers, relay), media, aesKey);
                        const pc = activeCall.connection;
                        // console.log("offer remoteIceCandidates", JSON.stringify(remoteIceCandidates))
                        await pc.setRemoteDescription(new RTCSessionDescription(offer));
                        // Enable using the same transceivers for sending media too, so total number of transceivers will be: audio, camera, screen audio, screen video
                        pc.getTransceivers().forEach((elem) => (elem.direction = "sendrecv"));
                        console.log("LALAL TRANSCE", pc.getTransceivers(), pc.getTransceivers().map((elem) => { var _a, _b; return "" + elem.mid + " " + ((_a = elem.sender.track) === null || _a === void 0 ? void 0 : _a.kind) + " " + ((_b = elem.sender.track) === null || _b === void 0 ? void 0 : _b.label); }));
                        let answer = await pc.createAnswer();
                        console.log("LALAL SDP", answer, answer.sdp);
                        // answer!.sdp = answer.sdp?.replace("a=recvonly", "a=sendrecv")
                        await pc.setLocalDescription(answer);
                        addIceCandidates(pc, remoteIceCandidates);
                        addIceCandidates(pc, afterCallInitializedCandidates);
                        afterCallInitializedCandidates = [];
                        // same as command for caller to use
                        resp = {
                            type: "answer",
                            answer: serialize(answer),
                            iceCandidates: await activeCall.iceCandidates,
                        };
                    }
                    // console.log("answer response", JSON.stringify(resp))
                    break;
                case "answer":
                    if (!pc) {
                        resp = { type: "error", message: "answer: call not started" };
                    }
                    else if (!pc.localDescription) {
                        resp = { type: "error", message: "answer: local description is not set" };
                    }
                    else if (pc.currentRemoteDescription) {
                        resp = { type: "error", message: "answer: remote description already set" };
                    }
                    else {
                        const answer = parse(command.answer);
                        const remoteIceCandidates = parse(command.iceCandidates);
                        // console.log("answer remoteIceCandidates", JSON.stringify(remoteIceCandidates))
                        console.log("LALAL SDP2", answer, answer.sdp);
                        await pc.setRemoteDescription(new RTCSessionDescription(answer));
                        addIceCandidates(pc, remoteIceCandidates);
                        resp = { type: "ok" };
                    }
                    break;
                case "ice":
                    const remoteIceCandidates = parse(command.iceCandidates);
                    if (pc) {
                        addIceCandidates(pc, remoteIceCandidates);
                        resp = { type: "ok" };
                    }
                    else {
                        afterCallInitializedCandidates = remoteIceCandidates;
                        resp = { type: "error", message: "ice: call not started yet, will add candidates later" };
                    }
                    break;
                case "media":
                    if (!activeCall) {
                        resp = { type: "error", message: "media: call not started" };
                    }
                    else if (!activeCall.cameraTrackWasSetBefore && command.source == CallMediaSource.Camera && command.enable) {
                        await startSendingCamera(activeCall, activeCall.localCamera);
                        resp = { type: "ok" };
                    }
                    else if ((command.source == CallMediaSource.Mic && activeCall.localStream.getAudioTracks().length > 0) ||
                        (command.source == CallMediaSource.Camera && activeCall.localStream.getVideoTracks().length > 0)) {
                        if (enableMedia(activeCall.localStream, command.source, command.enable)) {
                            resp = { type: "ok" };
                        }
                        else {
                            resp = { type: "error", message: "media: cannot enable media source" };
                        }
                    }
                    else {
                        if (await replaceMedia(activeCall, activeCall.localCamera)) {
                            resp = { type: "ok" };
                        }
                        else {
                            resp = { type: "error", message: "media: cannot replace media source" };
                        }
                    }
                    break;
                case "camera":
                    if (!activeCall || !pc) {
                        resp = { type: "error", message: "camera: call not started" };
                    }
                    else {
                        if (await replaceMedia(activeCall, command.camera)) {
                            resp = { type: "ok" };
                        }
                        else {
                            resp = { type: "error", message: "camera: cannot replace media source" };
                        }
                        resp = { type: "ok" };
                    }
                    break;
                case "description":
                    localizedState = command.state;
                    localizedDescription = command.description;
                    resp = { type: "ok" };
                    break;
                case "layout":
                    changeLayout(command.layout);
                    resp = { type: "ok" };
                    break;
                case "end":
                    endCall();
                    resp = { type: "ok" };
                    break;
                default:
                    resp = { type: "error", message: "unknown command" };
                    break;
            }
        }
        catch (e) {
            resp = { type: "error", message: `${command.type}: ${e.message}` };
        }
        const apiResp = { corrId, resp, command };
        sendMessageToNative(apiResp);
        return apiResp;
    }
    function endCall() {
        var _a;
        try {
            (_a = activeCall === null || activeCall === void 0 ? void 0 : activeCall.connection) === null || _a === void 0 ? void 0 : _a.close();
        }
        catch (e) {
            console.log(e);
        }
        shutdownCameraAndMic();
        activeCall = undefined;
        resetVideoElements();
    }
    function addIceCandidates(conn, iceCandidates) {
        for (const c of iceCandidates) {
            conn.addIceCandidate(new RTCIceCandidate(c));
            // console.log("addIceCandidates", JSON.stringify(c))
        }
    }
    async function setupMediaStreams(call) {
        const videos = getVideoElements();
        if (!videos)
            throw Error("no video elements");
        await setupEncryptionWorker(call);
        setupLocalStream(call);
        setupRemoteStream(call);
        setupCodecPreferences(call);
        // setupVideoElement(videos.local)
        // setupVideoElement(videos.remote)
        videos.local.srcObject = call.localStream;
        videos.localScreen.srcObject = call.localScreenStream;
        videos.remote.srcObject = call.remoteStream;
        videos.remoteScreen.srcObject = call.remoteScreenStream;
        // Without doing it manually Firefox shows black screen but video can be played in Picture-in-Picture
        videos.local.play().catch((e) => console.log(e));
        // videos.localScreen.play()
        // For example, exception can be: NotAllowedError: play() failed because the user didn't interact with the document first
        videos.remote.play().catch((e) => console.log(e));
        videos.remoteScreen.play().catch((e) => console.log(e));
    }
    async function setupEncryptionWorker(call) {
        if (call.aesKey) {
            if (!call.key)
                call.key = await callCrypto.decodeAesKey(call.aesKey);
            if (useWorker && !call.worker) {
                const workerCode = `const callCrypto = (${callCryptoFunction.toString()})(); (${workerFunction.toString()})()`;
                call.worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" })));
                call.worker.onerror = ({ error, filename, lineno, message }) => console.log({ error, filename, lineno, message });
                // call.worker.onmessage = ({data}) => console.log(JSON.stringify({message: data}))
                call.worker.onmessage = ({ data }) => {
                    console.log(JSON.stringify({ message: data }));
                    const transceiverMid = data.transceiverMid;
                    const mute = data.mute;
                    onMediaMuteUnmute(transceiverMid, mute);
                };
            }
        }
    }
    function setupLocalStream(call) {
        const videos = getVideoElements();
        if (!videos)
            throw Error("no video elements");
        const pc = call.connection;
        let { localStream } = call;
        for (const track of localStream.getTracks()) {
            pc.addTrack(track, localStream);
        }
        if (call.aesKey && call.key) {
            console.log("set up encryption for sending");
            for (const transceiver of pc.getTransceivers()) {
                const sender = transceiver.sender;
                setupPeerTransform(TransformOperation.Encrypt, sender, call.worker, call.aesKey, call.key, mediaSourceFromTransceiverMid(transceiver.mid) == CallMediaSource.Camera ? CallMediaType.Video : CallMediaType.Audio, transceiver.mid);
            }
        }
    }
    function setupRemoteStream(call) {
        // Pull tracks from remote stream as they arrive add them to remoteStream video
        const pc = call.connection;
        pc.ontrack = (event) => {
            console.log("LALAL ON TRACK ", event);
            try {
                if (call.aesKey && call.key) {
                    console.log("set up decryption for receiving");
                    setupPeerTransform(TransformOperation.Decrypt, event.receiver, call.worker, call.aesKey, call.key, event.receiver.track.kind == "video" ? CallMediaType.Video : CallMediaType.Audio, event.transceiver.mid);
                }
                if (event.streams.length > 0) {
                    for (const stream of event.streams) {
                        for (const track of stream.getTracks()) {
                            const mediaSource = mediaSourceFromTransceiverMid(event.transceiver.mid);
                            if (mediaSource == CallMediaSource.ScreenAudio || mediaSource == CallMediaSource.ScreenVideo) {
                                call.remoteScreenStream.addTrack(track);
                            }
                            else {
                                call.remoteStream.addTrack(track);
                            }
                        }
                    }
                }
                else {
                    const track = event.track;
                    const mediaSource = mediaSourceFromTransceiverMid(event.transceiver.mid);
                    if (mediaSource == CallMediaSource.ScreenAudio || mediaSource == CallMediaSource.ScreenVideo) {
                        call.remoteScreenStream.addTrack(track);
                    }
                    else {
                        call.remoteStream.addTrack(track);
                    }
                }
                console.log(`ontrack success`);
            }
            catch (e) {
                console.log(`ontrack error: ${e.message}`);
            }
        };
    }
    function setupCodecPreferences(call) {
        // We assume VP8 encoding in the decode/encode stages to get the initial
        // bytes to pass as plaintext so we enforce that here.
        // VP8 is supported by all supports of webrtc.
        // Use of VP8 by default may also reduce depacketisation issues.
        // We do not encrypt the first couple of bytes of the payload so that the
        // video elements can work by determining video keyframes and the opus mode
        // being used. This appears to be necessary for any video feed at all.
        // For VP8 this is the content described in
        //   https://tools.ietf.org/html/rfc6386#section-9.1
        // which is 10 bytes for key frames and 3 bytes for delta frames.
        // For opus (where encodedFrame.type is not set) this is the TOC byte from
        //   https://tools.ietf.org/html/rfc6716#section-3.1
        var _a;
        // Using RTCRtpReceiver instead of RTCRtpSender, see these lines:
        // -    if (!is_recv_codec && !is_send_codec) {
        // +    if (!is_recv_codec) {
        // https://webrtc.googlesource.com/src.git/+/db2f52ba88cf9f98211df2dabb3f8aca9251c4a2%5E%21/
        const capabilities = RTCRtpReceiver.getCapabilities("video");
        if (capabilities) {
            const { codecs } = capabilities;
            const selectedCodecIndex = codecs.findIndex((c) => c.mimeType === "video/VP8");
            const selectedCodec = codecs[selectedCodecIndex];
            codecs.splice(selectedCodecIndex, 1);
            codecs.unshift(selectedCodec);
            for (const t of call.connection.getTransceivers()) {
                // Firefox doesn't have this function implemented:
                // https://bugzilla.mozilla.org/show_bug.cgi?id=1396922
                if (((_a = t.sender.track) === null || _a === void 0 ? void 0 : _a.kind) === "video" && t.setCodecPreferences) {
                    try {
                        t.setCodecPreferences(codecs);
                    }
                    catch (error) {
                        // Shouldn't be here but in case something goes wrong, it will allow to make a call with auto-selected codecs
                        console.log("Failed to set codec preferences, trying without any preferences: " + error);
                    }
                }
            }
        }
    }
    async function startSendingCamera(call, camera) {
        console.log("LALAL STARTING SENDING VIDEO");
        const videos = getVideoElements();
        if (!videos)
            throw Error("no video elements");
        const pc = call.connection;
        // Taking the first video transceiver and use it for sending video from camera. Following tracks are for other purposes
        const tc = pc.getTransceivers().find((tc) => tc.receiver.track.kind == "video" && tc.direction == "sendrecv");
        console.log(pc.getTransceivers().map((elem) => { var _a, _b; return "" + ((_a = elem.sender.track) === null || _a === void 0 ? void 0 : _a.kind) + " " + ((_b = elem.receiver.track) === null || _b === void 0 ? void 0 : _b.kind) + " " + elem.direction; }));
        let localStream;
        try {
            localStream = await getLocalMediaStream(CallMediaType.Video, camera);
            for (const t of localStream.getVideoTracks()) {
                console.log("LALAL TC", tc, pc.getTransceivers());
                call.localStream.addTrack(t);
                tc === null || tc === void 0 ? void 0 : tc.sender.replaceTrack(t);
                localStream.removeTrack(t);
                // when adding track a `sender` will be created on that track automatically
                //pc.addTrack(t, call.localStream)
                console.log("LALAL ADDED VIDEO TRACK " + t);
            }
            call.localMediaSources.camera = true;
            call.cameraTrackWasSetBefore = true;
            localOrPeerMediaSourcesChanged(call);
        }
        catch (e) {
            console.log("Start sending camera error", e);
            desktopShowPermissionsAlert(CallMediaType.Video);
            return;
        }
        const sender = tc === null || tc === void 0 ? void 0 : tc.sender;
        console.log("LALAL SENDER " + sender + " " + (sender === null || sender === void 0 ? void 0 : sender.getParameters()));
        if (call.aesKey && call.key && sender) {
            setupPeerTransform(TransformOperation.Encrypt, sender, call.worker, call.aesKey, call.key, CallMediaType.Video, tc.mid);
        }
        // Without doing it manually Firefox shows black screen but video can be played in Picture-in-Picture
        videos.local.play().catch((e) => console.log(e));
        console.log("LALAL SENDING VIDEO");
    }
    toggleScreenShare = async function () {
        const call = activeCall;
        if (!call)
            return;
        const videos = getVideoElements();
        if (!videos)
            throw Error("no video elements");
        const pc = call.connection;
        if (!call.localMediaSources.screenVideo) {
            let localScreenStream;
            try {
                localScreenStream = await getLocalScreenCaptureStream();
            }
            catch (e) {
                return;
            }
            for (const t of localScreenStream.getTracks())
                call.localScreenStream.addTrack(t);
            for (const t of localScreenStream.getTracks())
                localScreenStream.removeTrack(t);
            pc.getTransceivers().forEach((elem) => {
                const source = mediaSourceFromTransceiverMid(elem.mid);
                const screenAudioTrack = call.localScreenStream.getTracks().find((elem) => elem.kind == "audio");
                const screenVideoTrack = call.localScreenStream.getTracks().find((elem) => elem.kind == "video");
                if (source == CallMediaSource.ScreenAudio && screenAudioTrack) {
                    elem.sender.replaceTrack(screenAudioTrack);
                    console.log("LALAL REPLACED AUDIO SCREEN TRACK");
                }
                else if (source == CallMediaSource.ScreenVideo && screenVideoTrack) {
                    elem.sender.replaceTrack(screenVideoTrack);
                    screenVideoTrack.onended = () => {
                        console.log("LALAL ENDED SCREEN TRACK");
                        toggleScreenShare();
                    };
                    console.log("LALAL REPLACED VIDEO SCREEN TRACK");
                }
                if (!call.screenShareWasSetupBefore &&
                    call.aesKey &&
                    call.key &&
                    (source == CallMediaSource.ScreenAudio || source == CallMediaSource.ScreenVideo)) {
                    setupPeerTransform(TransformOperation.Encrypt, elem.sender, call.worker, call.aesKey, call.key, source == CallMediaSource.ScreenVideo ? CallMediaType.Video : CallMediaType.Audio, elem.mid);
                }
            });
            call.screenShareWasSetupBefore = true;
            // videos.localScreen.pause()
            // videos.localScreen.srcObject = call.localScreenStream
            videos.localScreen.play().catch((e) => console.log(e));
            videos.localScreen.style.visibility = "visible";
        }
        else {
            pc.getTransceivers().forEach((elem) => {
                const source = mediaSourceFromTransceiverMid(elem.mid);
                if (source == CallMediaSource.ScreenAudio || source == CallMediaSource.ScreenVideo) {
                    elem.sender.replaceTrack(null);
                }
            });
            for (const t of call.localScreenStream.getTracks())
                t.stop();
            for (const t of call.localScreenStream.getTracks())
                call.localScreenStream.removeTrack(t);
            videos.localScreen.style.visibility = "hidden";
        }
        if (allowSendScreenAudio) {
            call.localMediaSources.screenAudio = !call.localMediaSources.screenAudio;
        }
        call.localMediaSources.screenVideo = !call.localMediaSources.screenVideo;
        localOrPeerMediaSourcesChanged(call);
    };
    async function replaceMedia(call, camera) {
        const videos = getVideoElements();
        if (!videos)
            throw Error("no video elements");
        const pc = call.connection;
        const oldAudioTracks = call.localStream.getAudioTracks();
        const audioWasEnabled = oldAudioTracks.some((elem) => elem.enabled);
        let localStream;
        try {
            localStream = await getLocalMediaStream(localMedia(call), camera);
        }
        catch (e) {
            console.log("Replace media error", e);
            desktopShowPermissionsAlert(CallMediaType.Video);
            return false;
        }
        for (const t of call.localStream.getTracks())
            t.stop();
        call.localCamera = camera;
        const audioTracks = localStream.getAudioTracks();
        const videoTracks = localStream.getVideoTracks();
        if (!audioWasEnabled && oldAudioTracks.length > 0) {
            audioTracks.forEach((elem) => (elem.enabled = false));
        }
        replaceTracks(pc, audioTracks);
        replaceTracks(pc, videoTracks);
        call.localStream = localStream;
        videos.local.srcObject = localStream;
        videos.local.play().catch((e) => console.log(e));
        call.localMediaSources.mic = call.localStream.getAudioTracks().length > 0;
        call.localMediaSources.camera = call.localStream.getVideoTracks().length > 0;
        localOrPeerMediaSourcesChanged(call);
        return true;
    }
    function replaceTracks(pc, tracks) {
        if (!tracks.length)
            return;
        const sender = pc.getSenders().find((s) => { var _a; return ((_a = s.track) === null || _a === void 0 ? void 0 : _a.kind) === tracks[0].kind; });
        if (sender)
            for (const t of tracks)
                sender.replaceTrack(t);
    }
    function mediaSourceFromTransceiverMid(mid) {
        switch (mid) {
            case "0":
                return CallMediaSource.Mic;
            case "1":
                return CallMediaSource.Camera;
            case "2":
                return CallMediaSource.ScreenAudio;
            case "3":
                return CallMediaSource.ScreenVideo;
            default:
                return CallMediaSource.Unknown;
        }
    }
    function setupPeerTransform(operation, peer, worker, aesKey, key, media, transceiverMid) {
        console.log("LALAL MEDIA " + media + " " + transceiverMid);
        if (worker && "RTCRtpScriptTransform" in window) {
            console.log(`${operation} with worker & RTCRtpScriptTransform`);
            peer.transform = new RTCRtpScriptTransform(worker, { operation, aesKey, media, transceiverMid });
        }
        else if ("createEncodedStreams" in peer) {
            const { readable, writable } = peer.createEncodedStreams();
            if (worker) {
                console.log(`${operation} with worker`);
                worker.postMessage({ operation, readable, writable, aesKey, media, transceiverMid }, [
                    readable,
                    writable,
                ]);
            }
            else {
                console.log(`${operation} without worker`);
                const onMediaMuteUnmuteConst = (mute) => {
                    onMediaMuteUnmute(transceiverMid, mute);
                };
                const transform = callCrypto.transformFrame[operation](key, onMediaMuteUnmuteConst);
                readable.pipeThrough(new TransformStream({ transform })).pipeTo(writable);
            }
        }
        else {
            console.log(`no ${operation}`);
        }
    }
    function onMediaMuteUnmute(transceiverMid, mute) {
        const videos = getVideoElements();
        if (!videos)
            throw Error("no video elements");
        if (!activeCall)
            return;
        const source = mediaSourceFromTransceiverMid(transceiverMid);
        console.log("LALAL ON MUTE/UNMUTE", mute, source, transceiverMid);
        const sources = activeCall.peerMediaSources;
        if (source == CallMediaSource.Mic && activeCall.peerMediaSources.mic == mute) {
            const resp = {
                type: "peerMedia",
                media: CallMediaType.Audio,
                source: source,
                enabled: !mute,
            };
            sources.mic = !mute;
            activeCall.peerMediaSources = sources;
            sendMessageToNative({ resp: resp });
            if (!mute)
                videos.remote.play().catch((e) => console.log(e));
        }
        else if (source == CallMediaSource.Camera && activeCall.peerMediaSources.camera == mute) {
            const resp = {
                type: "peerMedia",
                media: CallMediaType.Video,
                source: source,
                enabled: !mute,
            };
            sources.camera = !mute;
            activeCall.peerMediaSources = sources;
            videos.remote.style.visibility = !mute ? "visible" : "hidden";
            sendMessageToNative({ resp: resp });
            if (!mute)
                videos.remote.play().catch((e) => console.log(e));
        }
        else if (source == CallMediaSource.ScreenAudio && activeCall.peerMediaSources.screenAudio == mute) {
            const resp = {
                type: "peerMedia",
                media: CallMediaType.Audio,
                source: source,
                enabled: !mute,
            };
            sources.screenAudio = !mute;
            activeCall.peerMediaSources = sources;
            sendMessageToNative({ resp: resp });
            if (!mute)
                videos.remoteScreen.play().catch((e) => console.log(e));
        }
        else if (source == CallMediaSource.ScreenVideo && activeCall.peerMediaSources.screenVideo == mute) {
            const resp = {
                type: "peerMedia",
                media: CallMediaType.Video,
                source: source,
                enabled: !mute,
            };
            sources.screenVideo = !mute;
            activeCall.peerMediaSources = sources;
            videos.remoteScreen.style.visibility = !mute ? "visible" : "hidden";
            sendMessageToNative({ resp: resp });
            if (!mute)
                videos.remoteScreen.play().catch((e) => console.log(e));
        }
        if (activeCall.peerMediaSources.screenVideo) {
            videos.remote.className = "collapsed";
        }
        else {
            videos.remote.className = "inline";
        }
        localOrPeerMediaSourcesChanged(activeCall);
    }
    function getLocalMediaStream(mediaType, facingMode) {
        const constraints = callMediaConstraints(mediaType, facingMode);
        return navigator.mediaDevices.getUserMedia(constraints);
    }
    function getEmptyStream(mediaType, pc) {
        const stream = new MediaStream();
        pc.addTransceiver("audio", { streams: [stream] });
        if (mediaType == CallMediaType.Video) {
            pc.addTransceiver("video", { streams: [stream] });
        }
        return stream;
    }
    function getLocalScreenCaptureStream() {
        const constraints /* DisplayMediaStreamConstraints */ = {
            video: {
                frameRate: 24,
                //width: {
                //min: 480,
                //ideal: 720,
                //max: 1280,
                //},
                //aspectRatio: 1.33,
            },
            audio: allowSendScreenAudio,
            // This works with Chrome, Edge, Opera, but not with Firefox and Safari
            // systemAudio: "include"
        };
        return navigator.mediaDevices.getDisplayMedia(constraints);
    }
    function callMediaConstraints(mediaType, facingMode) {
        switch (mediaType) {
            case CallMediaType.Audio:
                return { audio: true, video: false };
            case CallMediaType.Video:
                return {
                    audio: true,
                    video: {
                        frameRate: 24,
                        width: {
                            min: 480,
                            ideal: 720,
                            max: 1280,
                        },
                        aspectRatio: 1.33,
                        facingMode,
                    },
                };
        }
    }
    function supportsInsertableStreams(useWorker) {
        return (("createEncodedStreams" in RTCRtpSender.prototype && "createEncodedStreams" in RTCRtpReceiver.prototype) ||
            (!!useWorker && "RTCRtpScriptTransform" in window));
    }
    function shutdownCameraAndMic() {
        if (activeCall === null || activeCall === void 0 ? void 0 : activeCall.localStream) {
            activeCall.localStream.getTracks().forEach((track) => track.stop());
        }
    }
    function resetVideoElements() {
        const videos = getVideoElements();
        if (!videos)
            return;
        videos.local.srcObject = null;
        videos.localScreen.srcObject = null;
        videos.remote.srcObject = null;
        videos.remoteScreen.srcObject = null;
    }
    function getVideoElements() {
        const local = document.getElementById("local-video-stream");
        const localScreen = document.getElementById("local-screen-video-stream");
        const remote = document.getElementById("remote-video-stream");
        const remoteScreen = document.getElementById("remote-screen-video-stream");
        if (!(local &&
            localScreen &&
            remote &&
            remoteScreen &&
            local instanceof HTMLMediaElement &&
            localScreen instanceof HTMLMediaElement &&
            remote instanceof HTMLMediaElement &&
            remoteScreen instanceof HTMLMediaElement))
            return;
        return { local, localScreen, remote, remoteScreen };
    }
    // function setupVideoElement(video: HTMLElement) {
    //   // TODO use display: none
    //   video.style.opacity = "0"
    //   video.onplaying = () => {
    //     video.style.opacity = "1"
    //   }
    // }
    function enableMedia(s, source, enable) {
        if (!activeCall)
            return false;
        const tracks = source == CallMediaSource.Camera ? s.getVideoTracks() : s.getAudioTracks();
        let changedSource = false;
        for (const t of tracks) {
            for (const transceiver of activeCall.connection.getTransceivers()) {
                if ((t.kind == CallMediaType.Audio && mediaSourceFromTransceiverMid(transceiver.mid) == CallMediaSource.Mic) ||
                    (t.kind == CallMediaType.Video && mediaSourceFromTransceiverMid(transceiver.mid) == CallMediaSource.Camera)) {
                    if (enable) {
                        t.enabled = true;
                        transceiver.sender.replaceTrack(t);
                    }
                    else {
                        t.enabled = false;
                        transceiver.sender.replaceTrack(null);
                    }
                    if (source == CallMediaSource.Mic) {
                        activeCall.localMediaSources.mic = enable;
                        changedSource = true;
                    }
                    else if (source == CallMediaSource.Camera) {
                        activeCall.localMediaSources.camera = enable;
                        changedSource = true;
                    }
                }
            }
        }
        if (changedSource) {
            localOrPeerMediaSourcesChanged(activeCall);
            return true;
        }
        else {
            console.log("Enable media error");
            desktopShowPermissionsAlert(source == CallMediaSource.Mic ? CallMediaType.Audio : CallMediaType.Video);
            return false;
        }
    }
    return processCommand;
})();
function toggleRemoteVideoFitFill() {
    const remote = document.getElementById("remote-video-stream");
    remote.style.objectFit = remote.style.objectFit != "contain" ? "contain" : "cover";
}
function toggleRemoteScreenVideoFitFill() {
    const remoteScreen = document.getElementById("remote-screen-video-stream");
    remoteScreen.style.objectFit = remoteScreen.style.objectFit != "contain" ? "contain" : "cover";
}
function togglePeerMedia(s, media) {
    if (!activeCall)
        return false;
    let res = false;
    const tracks = media == CallMediaType.Video ? s.getVideoTracks() : s.getAudioTracks();
    for (const t of tracks) {
        t.enabled = !t.enabled;
        res = t.enabled;
    }
    return res;
}
function changeLayout(layout) {
    const local = document.getElementById("local-video-stream");
    const remote = document.getElementById("remote-video-stream");
    switch (layout) {
        case LayoutType.Default:
            local.className = "inline";
            remote.className = "inline";
            local.style.visibility = "visible";
            remote.style.visibility = "visible";
            break;
        case LayoutType.LocalVideo:
            local.className = "fullscreen";
            local.style.visibility = "visible";
            remote.style.visibility = "hidden";
            break;
        case LayoutType.RemoteVideo:
            remote.className = "fullscreen";
            local.style.visibility = "hidden";
            remote.style.visibility = "visible";
            break;
    }
}
function desktopShowPermissionsAlert(mediaType) {
    if (!isDesktop)
        return;
    if (mediaType == CallMediaType.Audio) {
        window.alert("Permissions denied. Please, allow access to mic to make the call working and hit unmute button. Don't reload the page.");
    }
    else {
        window.alert("Permissions denied. Please, allow access to mic and camera to make the call working and hit unmute button. Don't reload the page.");
    }
}
// Cryptography function - it is loaded both in the main window and in worker context (if the worker is used)
function callCryptoFunction() {
    const initialPlainTextRequired = {
        key: 10,
        delta: 3,
        empty: 1,
    };
    const IV_LENGTH = 12;
    function encryptFrame(key) {
        return async (frame, controller) => {
            const data = new Uint8Array(frame.data);
            const n = initialPlainTextRequired[frame.type] || 1;
            const iv = randomIV();
            const initial = data.subarray(0, n);
            const plaintext = data.subarray(n, data.byteLength);
            try {
                const ciphertext = plaintext.length
                    ? new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv.buffer }, key, plaintext))
                    : new Uint8Array(0);
                frame.data = concatN(initial, ciphertext, iv).buffer;
                controller.enqueue(frame);
                // console.log("LALAL ENCRYPT", frame.data.byteLength)
            }
            catch (e) {
                console.log(`encryption error ${e}`);
                throw e;
            }
        };
    }
    function decryptFrame(key, onMediaMuteUnmute) {
        let wasMuted = true;
        let timeout = 0;
        const resetTimeout = () => {
            if (wasMuted) {
                wasMuted = false;
                onMediaMuteUnmute(wasMuted);
            }
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                if (!wasMuted) {
                    wasMuted = true;
                    onMediaMuteUnmute(wasMuted);
                }
            }, 3000);
        };
        // let lastBytes: number[] = []
        return async (frame, controller) => {
            const data = new Uint8Array(frame.data);
            const n = initialPlainTextRequired[frame.type] || 1;
            const initial = data.subarray(0, n);
            const ciphertext = data.subarray(n, data.byteLength - IV_LENGTH);
            const iv = data.subarray(data.byteLength - IV_LENGTH, data.byteLength);
            try {
                const plaintext = ciphertext.length
                    ? new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext))
                    : new Uint8Array(0);
                frame.data = concatN(initial, plaintext).buffer;
                controller.enqueue(frame);
                resetTimeout();
                // Check by bytes if track was disabled (not set to null)
                // lastBytes.push(frame.data.byteLength)
                // const sliced = lastBytes.slice(-20, lastBytes.length)
                // const average = sliced.reduce((prev, value) => value + prev, 0) / Math.max(1, sliced.length)
                // if (lastBytes.length > 20) {
                //   lastBytes = sliced
                // }
                // if (frame.type) {
                //   console.log("LALAL DECRYPT", frame.type, frame.data.byteLength, average)
                // }
                // // frame.type is undefined for audio stream, but defined for video
                // if (frame.type && wasMuted && average > 200) {
                //   wasMuted = false
                //   onMediaMuteUnmute(false)
                // } else if (frame.type && !wasMuted && average < 200) {
                //   wasMuted = true
                //   onMediaMuteUnmute(true)
                // }
            }
            catch (e) {
                console.log(`decryption error ${e}`);
                throw e;
            }
        };
    }
    function decodeAesKey(aesKey) {
        const keyData = callCrypto.decodeBase64url(callCrypto.encodeAscii(aesKey));
        return crypto.subtle.importKey("raw", keyData, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    }
    function concatN(...bs) {
        const a = new Uint8Array(bs.reduce((size, b) => size + b.byteLength, 0));
        bs.reduce((offset, b) => {
            a.set(b, offset);
            return offset + b.byteLength;
        }, 0);
        return a;
    }
    function randomIV() {
        return crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    }
    const base64urlChars = new Uint8Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("").map((c) => c.charCodeAt(0)));
    const base64urlLookup = new Array(256);
    base64urlChars.forEach((c, i) => (base64urlLookup[c] = i));
    const char_equal = "=".charCodeAt(0);
    function encodeAscii(s) {
        const a = new Uint8Array(s.length);
        let i = s.length;
        while (i--)
            a[i] = s.charCodeAt(i);
        return a;
    }
    function decodeAscii(a) {
        let s = "";
        for (let i = 0; i < a.length; i++)
            s += String.fromCharCode(a[i]);
        return s;
    }
    function encodeBase64url(a) {
        const len = a.length;
        const b64len = Math.ceil(len / 3) * 4;
        const b64 = new Uint8Array(b64len);
        let j = 0;
        for (let i = 0; i < len; i += 3) {
            b64[j++] = base64urlChars[a[i] >> 2];
            b64[j++] = base64urlChars[((a[i] & 3) << 4) | (a[i + 1] >> 4)];
            b64[j++] = base64urlChars[((a[i + 1] & 15) << 2) | (a[i + 2] >> 6)];
            b64[j++] = base64urlChars[a[i + 2] & 63];
        }
        if (len % 3)
            b64[b64len - 1] = char_equal;
        if (len % 3 === 1)
            b64[b64len - 2] = char_equal;
        return b64;
    }
    function decodeBase64url(b64) {
        let len = b64.length;
        if (len % 4)
            return;
        let bLen = (len * 3) / 4;
        if (b64[len - 1] === char_equal) {
            len--;
            bLen--;
            if (b64[len - 1] === char_equal) {
                len--;
                bLen--;
            }
        }
        const bytes = new Uint8Array(bLen);
        let i = 0;
        let pos = 0;
        while (i < len) {
            const enc1 = base64urlLookup[b64[i++]];
            const enc2 = i < len ? base64urlLookup[b64[i++]] : 0;
            const enc3 = i < len ? base64urlLookup[b64[i++]] : 0;
            const enc4 = i < len ? base64urlLookup[b64[i++]] : 0;
            if (enc1 === undefined || enc2 === undefined || enc3 === undefined || enc4 === undefined)
                return;
            bytes[pos++] = (enc1 << 2) | (enc2 >> 4);
            bytes[pos++] = ((enc2 & 15) << 4) | (enc3 >> 2);
            bytes[pos++] = ((enc3 & 3) << 6) | (enc4 & 63);
        }
        return bytes;
    }
    return {
        transformFrame: { encrypt: encryptFrame, decrypt: decryptFrame },
        decodeAesKey,
        encodeAscii,
        decodeAscii,
        encodeBase64url,
        decodeBase64url,
    };
}
// If the worker is used for decryption, this function code (as string) is used to load the worker via Blob
// We have to use worker optionally, as it crashes in Android web view, regardless of how it is loaded
function workerFunction() {
    // encryption with createEncodedStreams support
    self.addEventListener("message", async ({ data }) => {
        await setupTransform(data);
    });
    // encryption using RTCRtpScriptTransform.
    if ("RTCTransformEvent" in self) {
        self.addEventListener("rtctransform", async ({ transformer }) => {
            try {
                const { operation, aesKey, transceiverMid } = transformer.options;
                const { readable, writable } = transformer;
                await setupTransform({ operation, aesKey, transceiverMid, readable, writable });
                self.postMessage({ result: "setupTransform success" });
            }
            catch (e) {
                self.postMessage({ message: `setupTransform error: ${e.message}` });
            }
        });
    }
    async function setupTransform({ operation, aesKey, transceiverMid, readable, writable }) {
        const key = await callCrypto.decodeAesKey(aesKey);
        const onMediaMuteUnmute = (mute) => {
            self.postMessage({ transceiverMid: transceiverMid, mute: mute });
        };
        const transform = callCrypto.transformFrame[operation](key, onMediaMuteUnmute);
        readable.pipeThrough(new TransformStream({ transform })).pipeTo(writable);
    }
}
//# sourceMappingURL=call.js.map