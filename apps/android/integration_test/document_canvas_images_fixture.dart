// Shared HTML document for the Chrome image/canvas oracle and native parity test.
const documentCanvasImagesHtml = r'''<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Native document canvas image fixture</title>
  <style>
    html, body { margin: 0; padding: 0; background: #fff; }
    #images-canvas { display: block; width: 100px; height: 48px; }
    #canvas-images-result { display: none; }
  </style>
</head>
<body>
  <canvas id="images-canvas" width="100" height="48"></canvas>
  <img id="markup-image" alt="markup image" style="display:none">
  <pre id="canvas-images-result">WAITING</pre>
  <script>
    (() => {
      const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAI0lEQVR42mP4IKHyH4TFznqBMQOGgFLMj/8g/OucEBhjCAAAzk4mlQn3W8cAAAAASUVORK5CYII=';
      const replacementPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAI0lEQVR42mMQufTwPwif1bgOxgwYAr+aZP6D8I8fP8AYQwAADKwwPVd47EcAAAAASUVORK5CYII=';
      const jpegBase64 = '/9j//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABxAAEBAAAAAAAAAAAAAAAAAAAEBgEBAQEAAAAAAAAAAAAAAAAAAwQGEAAABAUEAwEAAAAAAAAAAAADAQIFBBIxBgARB7Q2hCETFBEAAAUCBQMFAQAAAAAAAAAAAwQCAREFEwYUABIHIiMhhbQ2hDe1/8AAEQgABAAEAwESAAISAAMSAP/aAAwDAQACEQMRAD8AoLFYWmMtVvHHh5xF/pmV9Rk6yxQyS9JEIqEVCxm3fTmzyuWPmN5bOmcM8hVqk0kTKEi2Rsg7UDbLpAsMvuDpEFeRFqV1LeJhvGi55/V8RemfyiekL4eo+NwU1+vls/Uzs5kzdGL3LDuXC7RQQEBO0EJCegNMxLy7u+rcGfGyP2Pci6//2Q==';
      const svgSource = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4"><path fill="#f01824" d="M0 0h2v2H0z"/><path fill="#16cd4a" d="M2 0h2v2H2z"/><path fill="#225cf8" d="M0 2h2v2H0z"/><path fill="#face12" d="M2 2h2v2H2z"/></svg>';
      const dataPngUrl = 'data:image/png;base64,' + pngBase64;
      const replacementDataPngUrl = 'data:image/png;base64,' + replacementPngBase64;
      const dataJpegUrl = 'data:image/jpeg;base64,' + jpegBase64;
      const dataSvgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgSource);
      const canvas = document.querySelector('#images-canvas');
      const context = canvas.getContext('2d');
      const resultNode = document.querySelector('#canvas-images-result');

      function bytesForBase64(value) {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      }

      function state(image) {
        return {
          complete: Boolean(image.complete),
          currentSrc: String(image.currentSrc || ''),
          naturalWidth: Number(image.naturalWidth || 0),
          naturalHeight: Number(image.naturalHeight || 0),
          src: String(image.src || ''),
          srcAttribute: image.getAttribute('src')
        };
      }

      function observe(image) {
        const events = [];
        const record = event => events.push({type: event.type, state: state(image)});
        image.addEventListener('load', record);
        image.addEventListener('error', record);
        return events;
      }

      function waitForTerminalEvent(image, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
          let finished = false;
          let timeout = 0;
          const finish = event => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            image.removeEventListener('load', onLoad);
            image.removeEventListener('error', onError);
            resolve({type: event.type, state: state(image)});
          };
          const onLoad = event => finish(event);
          const onError = event => finish(event);
          timeout = setTimeout(() => {
            if (finished) return;
            finished = true;
            image.removeEventListener('load', onLoad);
            image.removeEventListener('error', onError);
            reject(new Error('Image did not load or fail within ' + timeoutMs + 'ms'));
          }, timeoutMs);
          image.addEventListener('load', onLoad);
          image.addEventListener('error', onError);
        });
      }

      async function decodeResult(image) {
        if (typeof image.decode !== 'function') return {status: 'unsupported'};
        try {
          await image.decode();
          return {status: 'resolved'};
        } catch (error) {
          return {status: 'rejected', errorName: error && error.name || 'Error'};
        }
      }

      function capture(operation) {
        try {
          operation();
          return {status: 'ok', errorName: null};
        } catch (error) {
          return {status: 'throws', errorName: error && error.name || 'Error'};
        }
      }

      function delay(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
      }

      async function loadImage(source, sourceKind) {
        const image = new Image();
        const events = observe(image);
        const initial = state(image);
        const terminalPromise = waitForTerminalEvent(image);
        image.src = source;
        const afterAssignment = state(image);
        const decodePromise = decodeResult(image);
        const terminal = await terminalPromise;
        const decode = await decodePromise;
        return {
          image,
          trace: {sourceKind, initial, afterAssignment, terminal, events: events.slice(), decode}
        };
      }

      async function run() {
        const result = {
          fixture: 'document-canvas-images-v1',
          canvas: {id: canvas.id, width: canvas.width, height: canvas.height},
          sources: {},
          sourceReplacement: {},
          blobRevocation: {},
          cancellation: {},
          draws: {},
          invalidDrawImage: {},
          imageSmoothing: {
            defaultEnabled: context.imageSmoothingEnabled,
            defaultQuality: context.imageSmoothingQuality
          }
        };

        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);

        const noSourceImage = new Image();
        result.sources.noSource = {
          initial: state(noSourceImage),
          draw: capture(() => context.drawImage(noSourceImage, 88, 0)),
          decode: await decodeResult(noSourceImage)
        };

        try {
          const calledWithoutNew = Image();
          result.imageConstructor = {
            status: 'returned',
            valueType: Object.prototype.toString.call(calledWithoutNew),
            state: state(calledWithoutNew)
          };
        } catch (error) {
          result.imageConstructor = {
            status: 'throws',
            errorName: error && error.name || 'Error',
            message: String(error && error.message || error)
          };
        }
        const imageConstructorArguments = {
          zero: new Image(),
          one: new Image(20),
          two: new Image(20, 10)
        };
        result.imageConstructorArguments = Object.fromEntries(
          Object.entries(imageConstructorArguments).map(([count, image]) => [count, {
            width: image.width,
            height: image.height,
            widthAttribute: image.getAttribute('width'),
            heightAttribute: image.getAttribute('height'),
            ...state(image)
          }])
        );

        const markupImage = document.querySelector('#markup-image');
        const markupEvents = observe(markupImage);
        const markupInitial = state(markupImage);
        const markupWait = waitForTerminalEvent(markupImage);
        markupImage.setAttribute('src', '/quadrants.png?html-element=1');
        const markupAfterAssignment = state(markupImage);
        const markupDecodePromise = decodeResult(markupImage);
        const markupTerminal = await markupWait;
        const markupDecode = await markupDecodePromise;
        result.sources.htmlImgElement = {
          sourceKind: 'markup-img-http-png',
          initial: markupInitial,
          afterAssignment: markupAfterAssignment,
          terminal: markupTerminal,
          events: markupEvents.slice(),
          decode: markupDecode
        };

        const data = await loadImage(dataPngUrl, 'data-png');
        const quadrantBytes = bytesForBase64(pngBase64);
        const blobUrl = URL.createObjectURL(new Blob([quadrantBytes], {type: 'image/png'}));
        const blob = await loadImage(blobUrl, 'blob-png');
        const http = await loadImage('/quadrants.png', 'http-png');
        const jpeg = await loadImage(dataJpegUrl, 'data-jpeg');
        const svg = await loadImage(dataSvgUrl, 'data-svg');
        result.sources.dataPng = data.trace;
        result.sources.blobPng = blob.trace;
        result.sources.httpPng = http.trace;
        result.sources.dataJpeg = jpeg.trace;
        result.sources.dataSvg = svg.trace;

        result.draws.threeArgument = capture(() => context.drawImage(data.image, 0, 0));
        result.draws.fiveArgument = capture(() => context.drawImage(data.image, 8, 0, 8, 8));
        result.draws.nineArgumentCrop = capture(() => context.drawImage(data.image, 0, 0, 2, 2, 20, 0, 8, 8));
        result.draws.negativeSourceWidth = capture(() => context.drawImage(data.image, 2, 0, -2, 4, 32, 0, 8, 8));
        result.draws.negativeSourceHeight = capture(() => context.drawImage(data.image, 0, 2, 2, -2, 60, 0, 8, 8));
        result.draws.negativeDestinationSize = capture(() => context.drawImage(data.image, 48, 16, -8, -8));
        result.draws.sourceClippedAtLeft = capture(() => context.drawImage(data.image, -2, 0, 4, 4, 0, 20, 8, 8));
        context.save();
        context.imageSmoothingEnabled = true;
        result.draws.smoothingEnabled = capture(() => context.drawImage(data.image, 0, 28, 7, 7));
        context.restore();
        context.save();
        context.imageSmoothingEnabled = false;
        result.draws.smoothingDisabled = capture(() => context.drawImage(data.image, 8, 28, 7, 7));
        context.restore();
        result.draws.blobSource = capture(() => context.drawImage(blob.image, 16, 20, 4, 4));
        result.draws.httpSource = capture(() => context.drawImage(http.image, 24, 20, 4, 4));
        result.draws.jpegSource = capture(() => context.drawImage(jpeg.image, 48, 36, 4, 4));
        result.draws.svgSource = capture(() => context.drawImage(svg.image, 40, 36, 4, 4));

        context.fillStyle = '#ffffff';
        context.fillRect(84, 20, 8, 8);
        context.save();
        context.globalAlpha = 0.5;
        context.globalCompositeOperation = 'multiply';
        context.translate(84, 20);
        context.scale(2, 2);
        result.draws.transformedAlphaComposite = capture(() => context.drawImage(data.image, 0, 0, 4, 4));
        context.restore();

        const replacement = new Image();
        const replacementEvents = observe(replacement);
        const replacementInitial = state(replacement);
        const firstWait = waitForTerminalEvent(replacement);
        replacement.src = dataPngUrl;
        const firstAssignment = state(replacement);
        const firstDecodePromise = decodeResult(replacement);
        const firstLoaded = await firstWait;
        const firstDecode = await firstDecodePromise;
        result.sourceReplacement.before = {initial: replacementInitial, afterAssignment: firstAssignment, terminal: firstLoaded, decode: firstDecode};
        result.draws.sourceBeforeReplacement = capture(() => context.drawImage(replacement, 0, 36));
        const secondWait = waitForTerminalEvent(replacement);
        replacement.src = replacementDataPngUrl;
        const secondAssignment = state(replacement);
        const secondDecodePromise = decodeResult(replacement);
        const secondLoaded = await secondWait;
        const secondDecode = await secondDecodePromise;
        result.sourceReplacement.after = {afterAssignment: secondAssignment, terminal: secondLoaded, decode: secondDecode, events: replacementEvents.slice()};
        result.draws.sourceAfterReplacement = capture(() => context.drawImage(replacement, 8, 36));

        const pendingFailure = new Image();
        const pendingFailureEvents = observe(pendingFailure);
        const pendingFailureInitial = state(pendingFailure);
        const pendingFailureInitialWait = waitForTerminalEvent(pendingFailure);
        pendingFailure.src = dataPngUrl;
        const pendingFailureInitialTerminal = await pendingFailureInitialWait;
        context.drawImage(pendingFailure, 56, 36, 4, 4);
        const pendingFailureLoadedState = state(pendingFailure);
        const pendingFailureWait = waitForTerminalEvent(pendingFailure);
        pendingFailure.src = '/slow-broken.png?case=loaded-image-replacement';
        const pendingFailureAfterAssignment = state(pendingFailure);
        await delay(50);
        const pendingFailureWhilePending = state(pendingFailure);
        const pendingFailureDraw = capture(() => context.drawImage(pendingFailure, 56, 42, 4, 4));
        const pendingFailureTerminal = await pendingFailureWait;
        const pendingFailureDrawAfterError = capture(() => context.drawImage(pendingFailure, 64, 36, 4, 4));
        result.sourceReplacement.loadedThenPendingError = {
          initial: pendingFailureInitial,
          initialTerminal: pendingFailureInitialTerminal,
          loaded: pendingFailureLoadedState,
          afterAssignment: pendingFailureAfterAssignment,
          whilePending: pendingFailureWhilePending,
          pendingDraw: pendingFailureDraw,
          terminal: pendingFailureTerminal,
          drawAfterError: pendingFailureDrawAfterError,
          events: pendingFailureEvents.slice()
        };

        const revokeImmediatelyUrl = URL.createObjectURL(new Blob([quadrantBytes], {type: 'image/png'}));
        const revokeImmediatelyImage = new Image();
        const revokeImmediatelyEvents = observe(revokeImmediatelyImage);
        const revokeImmediatelyInitial = state(revokeImmediatelyImage);
        const revokeImmediatelyWait = waitForTerminalEvent(revokeImmediatelyImage);
        revokeImmediatelyImage.src = revokeImmediatelyUrl;
        const revokeImmediatelyAssignment = state(revokeImmediatelyImage);
        URL.revokeObjectURL(revokeImmediatelyUrl);
        const revokeImmediatelyTerminal = await revokeImmediatelyWait;
        const revokeImmediatelyDecode = await decodeResult(revokeImmediatelyImage);
        result.blobRevocation.immediatelyAfterAssignment = {
          initial: revokeImmediatelyInitial,
          afterAssignment: revokeImmediatelyAssignment,
          terminal: revokeImmediatelyTerminal,
          events: revokeImmediatelyEvents.slice(),
          decode: revokeImmediatelyDecode
        };
        if (revokeImmediatelyTerminal.type === 'load') {
          result.draws.immediatelyRevokedBlob = capture(() => context.drawImage(revokeImmediatelyImage, 24, 36, 4, 4));
        }

        const revokeInLoadUrl = URL.createObjectURL(new Blob([quadrantBytes], {type: 'image/png'}));
        const revokeInLoadImage = new Image();
        const revokeInLoadEvents = observe(revokeInLoadImage);
        let revokedInLoad = false;
        revokeInLoadImage.addEventListener('load', () => {
          URL.revokeObjectURL(revokeInLoadUrl);
          revokedInLoad = true;
        });
        const revokeInLoadInitial = state(revokeInLoadImage);
        const revokeInLoadWait = waitForTerminalEvent(revokeInLoadImage);
        revokeInLoadImage.src = revokeInLoadUrl;
        const revokeInLoadAssignment = state(revokeInLoadImage);
        const revokeInLoadTerminal = await revokeInLoadWait;
        const revokeInLoadDecode = await decodeResult(revokeInLoadImage);
        result.blobRevocation.inLoadThenLaterDraw = {
          initial: revokeInLoadInitial,
          afterAssignment: revokeInLoadAssignment,
          terminal: revokeInLoadTerminal,
          events: revokeInLoadEvents.slice(),
          revokedInLoad,
          decode: revokeInLoadDecode
        };
        if (revokeInLoadTerminal.type === 'load') {
          result.draws.blobRevokedInLoad = capture(() => context.drawImage(revokeInLoadImage, 16, 36, 4, 4));
        }

        const cancellationImage = new Image();
        const cancellationEvents = observe(cancellationImage);
        const cancellationInitial = state(cancellationImage);
        cancellationImage.src = '/slow.png?case=cancel';
        const cancellationAfterAssignment = state(cancellationImage);
        await delay(50);
        const cancellationBeforeReplacement = state(cancellationImage);
        const pendingDraw = capture(() => context.drawImage(cancellationImage, 88, 32));
        const cancellationWait = waitForTerminalEvent(cancellationImage);
        cancellationImage.src = replacementDataPngUrl;
        const cancellationAfterReplacement = state(cancellationImage);
        const cancellationDecodePromise = decodeResult(cancellationImage);
        const cancellationTerminal = await cancellationWait;
        const cancellationDecode = await cancellationDecodePromise;
        await delay(350);
        result.cancellation = {
          initial: cancellationInitial,
          afterSlowAssignment: cancellationAfterAssignment,
          beforeReplacement: cancellationBeforeReplacement,
          pendingDraw,
          afterReplacement: cancellationAfterReplacement,
          terminal: cancellationTerminal,
          events: cancellationEvents.slice(),
          decode: cancellationDecode
        };
        result.draws.cancellationReplacement = capture(() => context.drawImage(cancellationImage, 32, 36, 4, 4));

        const broken = await loadImage('/broken.png', 'http-broken-image');
        result.sources.brokenHttpPng = broken.trace;
        result.draws.brokenImage = capture(() => context.drawImage(broken.image, 88, 32));

        result.invalidDrawImage.wrongType = capture(() => context.drawImage({}, 88, 8));
        result.invalidDrawImage.zeroSourceWidth = capture(() => context.drawImage(data.image, 0, 0, 0, 4, 88, 8, 8, 8));
        result.invalidDrawImage.zeroSourceHeight = capture(() => context.drawImage(data.image, 0, 0, 4, 0, 88, 8, 8, 8));
        result.invalidDrawImage.zeroDestinationWidth = capture(() => context.drawImage(data.image, 88, 8, 0, 8));
        result.invalidDrawImage.zeroDestinationHeight = capture(() => context.drawImage(data.image, 88, 8, 8, 0));
        result.invalidDrawImage.nanDestination = capture(() => context.drawImage(data.image, NaN, 8));
        result.invalidDrawImage.infiniteDestination = capture(() => context.drawImage(data.image, Infinity, 8));
        result.invalidDrawImage.arity = {
          zero: capture(() => context.drawImage()),
          two: capture(() => context.drawImage(data.image, 0)),
          four: capture(() => context.drawImage(data.image, 0, 0, 4)),
          six: capture(() => context.drawImage(data.image, 0, 0, 4, 4, 4)),
          ten: capture(() => context.drawImage(data.image, 0, 0, 4, 4, 0, 0, 4, 4, 4))
        };
        result.sources.blobUrlAfterOrdinaryUse = state(blob.image);
        result.sourceUrls = {
          dataPngScheme: new URL(dataPngUrl).protocol.slice(0, -1),
          blobPngScheme: new URL(blobUrl).protocol.slice(0, -1),
          httpPngScheme: new URL('/quadrants.png', location.href).protocol.slice(0, -1),
          jpegMimeType: 'image/jpeg',
          svgMimeType: 'image/svg+xml'
        };
        return result;
      }

      const fixture = {canvas, context, result: null, ready: null};
      window.__documentCanvasImages = fixture;
      fixture.ready = run().then(result => {
        fixture.result = result;
        resultNode.textContent = JSON.stringify(result);
        return result;
      }).catch(error => {
        const failure = {fixture: 'document-canvas-images-v1', fixtureError: error && error.message || String(error)};
        fixture.result = failure;
        resultNode.textContent = JSON.stringify(failure);
        return failure;
      });
    })();
  </script>
</body>
</html>''';
