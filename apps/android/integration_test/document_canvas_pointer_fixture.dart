const documentCanvasPointerHtml = r'''<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Native document canvas pointer fixture</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      min-width: 390px;
      min-height: 1800px;
      background: #fff;
    }
    #pointer-host {
      padding: 32px 0 0 24px;
      width: 300px;
    }
    #pointer-canvas {
      display: block;
      width: 300px;
      height: 150px;
      touch-action: none;
      background: #fff;
    }
    #scroll-tail {
      width: 1px;
      height: 1600px;
    }
  </style>
</head>
<body>
  <main id="pointer-host">
    <canvas id="pointer-canvas" width="240" height="120"
      style="display:block;width:300px;height:150px;touch-action:none"></canvas>
  </main>
  <button type="button" onclick="window.__resetDocumentCanvasPointer('auto')">Enable page scrolling</button>
  <pre id="pointer-result" style="display:none"></pre>
  <div id="scroll-tail" aria-hidden="true"></div>
  <script>
    (() => {
      const canvas = document.querySelector('#pointer-canvas');
      const context = canvas.getContext('2d');
      const probe = window.__documentCanvasPointer = {
        events: [],
        captureCalls: [],
        droppedEvents: 0,
        touchAction: 'none'
      };
      const pointerIds = new Map();
      const lastPoints = new Map();
      const maxEvents = 128;

      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);

      function normalizedId(pointerId) {
        if (!pointerIds.has(pointerId)) {
          pointerIds.set(pointerId, 'pointer-' + (pointerIds.size + 1));
        }
        return pointerIds.get(pointerId);
      }

      canvas.addEventListener('pointerdown', event => {
        const id = normalizedId(event.pointerId);
        try {
          canvas.setPointerCapture(event.pointerId);
          probe.captureCalls.push({
            method: 'setPointerCapture',
            pointerId: id,
            rawPointerId: event.pointerId,
            ok: true,
            errorName: null
          });
        } catch (error) {
          probe.captureCalls.push({
            method: 'setPointerCapture',
            pointerId: id,
            rawPointerId: event.pointerId,
            ok: false,
            errorName: error && error.name || 'Error'
          });
        }
      });

      function record(event) {
        const rect = canvas.getBoundingClientRect();
        const hasPointerId = Number.isFinite(event.pointerId);
        const id = hasPointerId ? normalizedId(event.pointerId) : null;
        const offsetX = Number.isFinite(event.offsetX) ? event.offsetX : null;
        const offsetY = Number.isFinite(event.offsetY) ? event.offsetY : null;
        const mappedX = offsetX === null || rect.width === 0
          ? null : offsetX * canvas.width / rect.width;
        const mappedY = offsetY === null || rect.height === 0
          ? null : offsetY * canvas.height / rect.height;
        let hasCapture = null;
        if (hasPointerId) {
          try {
            hasCapture = canvas.hasPointerCapture(event.pointerId);
          } catch (_) {
            hasCapture = false;
          }
        }

        if (event.type.startsWith('pointer') && mappedX !== null && mappedY !== null) {
          const point = {x: mappedX, y: mappedY};
          if (event.type === 'pointermove' && lastPoints.has(id)) {
            const previous = lastPoints.get(id);
            context.beginPath();
            context.moveTo(previous.x, previous.y);
            context.lineTo(point.x, point.y);
            context.strokeStyle = '#e11d48';
            context.lineWidth = 4;
            context.lineCap = 'round';
            context.stroke();
          }
          if (event.type === 'pointerdown' || event.type === 'pointermove' ||
              event.type === 'pointerup' || event.type === 'pointercancel') {
            context.beginPath();
            context.arc(point.x, point.y, 3, 0, Math.PI * 2);
            context.fillStyle = '#e11d48';
            context.fill();
            if (event.type === 'pointerdown' || event.type === 'pointermove') {
              lastPoints.set(id, point);
            } else {
              lastPoints.delete(id);
            }
          }
        }

        const target = event.target;
        const entry = {
          type: event.type,
          constructorName: event.constructor && event.constructor.name || '',
          targetId: target instanceof Element ? target.id : '',
          currentTargetId: event.currentTarget instanceof Element
            ? event.currentTarget.id : '',
          pointerId: id,
          rawPointerId: hasPointerId ? event.pointerId : null,
          pointerType: hasPointerId ? event.pointerType : null,
          isPrimary: hasPointerId ? event.isPrimary : null,
          clientX: Number.isFinite(event.clientX) ? event.clientX : null,
          clientY: Number.isFinite(event.clientY) ? event.clientY : null,
          offsetX,
          offsetY,
          mappedX,
          mappedY,
          button: Number.isFinite(event.button) ? event.button : null,
          buttons: Number.isFinite(event.buttons) ? event.buttons : null,
          pressure: Number.isFinite(event.pressure) ? event.pressure : null,
          bubbles: event.bubbles,
          cancelable: event.cancelable,
          composed: event.composed,
          isTrusted: event.isTrusted,
          hasPointerCapture: hasCapture,
          rect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
            right: rect.right,
            bottom: rect.bottom
          },
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
          scrollTop: document.scrollingElement ? document.scrollingElement.scrollTop : null
        };
        if (probe.events.length < maxEvents) {
          probe.events.push(entry);
        } else {
          probe.droppedEvents++;
        }
        document.querySelector('#pointer-result').textContent = JSON.stringify(probe);
      }

      for (const type of [
        'pointerover', 'pointerenter', 'pointerdown', 'pointermove', 'pointerup',
        'pointercancel', 'pointerout', 'pointerleave', 'gotpointercapture',
        'lostpointercapture', 'mouseover', 'mouseenter', 'mousedown', 'mousemove',
        'mouseup', 'mouseout', 'mouseleave', 'click'
      ]) {
        canvas.addEventListener(type, record);
      }

      window.__resetDocumentCanvasPointer = action => {
        const nextAction = action === 'auto' ? 'auto' : 'none';
        canvas.style.touchAction = nextAction;
        probe.events.length = 0;
        probe.captureCalls.length = 0;
        probe.droppedEvents = 0;
        probe.touchAction = nextAction;
        pointerIds.clear();
        lastPoints.clear();
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        document.querySelector('#pointer-result').textContent = JSON.stringify(probe);
      };
    })();
  </script>
</body>
</html>''';
