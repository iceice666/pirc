// Shared parent document for the Chrome XHR oracle and native parity test.
const documentXhrHtml = r'''<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Document XHR parity</title>
</head>
<body>
  <h1>Document XHR parity</h1>
  <p id="xhr-visible">Running XMLHttpRequest parity probes…</p>
  <pre id="xhr-result" hidden>WAITING</pre>
  <script>
    (() => {
      const resultNode = document.querySelector('#xhr-result');
      const visibleNode = document.querySelector('#xhr-visible');

      function snapshot(xhr) {
        return {
          readyState: xhr.readyState,
          status: xhr.status,
          statusText: xhr.statusText,
          responseURL: xhr.responseURL,
          responseType: xhr.responseType,
          timeout: xhr.timeout,
          withCredentials: xhr.withCredentials
        };
      }

      function observe(xhr) {
        const events = [];
        for (const type of ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend']) {
          xhr.addEventListener(type, event => events.push({
            type,
            readyState: xhr.readyState,
            status: xhr.status,
            responseURL: xhr.responseURL,
            loaded: event.loaded,
            total: event.total,
            lengthComputable: event.lengthComputable
          }));
        }
        return events;
      }

      function terminalPromise(xhr, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
          let timer = 0;
          const finish = event => {
            clearTimeout(timer);
            for (const type of ['load', 'error', 'abort', 'timeout']) xhr.removeEventListener(type, finish);
            resolve(event.type);
          };
          timer = setTimeout(() => {
            for (const type of ['load', 'error', 'abort', 'timeout']) xhr.removeEventListener(type, finish);
            reject(new Error('XHR did not terminate within ' + timeoutMs + 'ms'));
          }, timeoutMs);
          for (const type of ['load', 'error', 'abort', 'timeout']) xhr.addEventListener(type, finish);
        });
      }

      function valueOf(xhr, responseType) {
        if (responseType === 'arraybuffer') {
          const response = xhr.response;
          return {
            kind: 'ArrayBuffer',
            isArrayBuffer: response instanceof ArrayBuffer,
            sameIdentity: response === xhr.response,
            bytes: response instanceof ArrayBuffer ? Array.from(new Uint8Array(response)) : null
          };
        }
        if (responseType === 'blob') {
          const response = xhr.response;
          return {
            kind: 'Blob',
            isBlob: response instanceof Blob,
            sameIdentity: response === xhr.response,
            type: response instanceof Blob ? response.type : null,
            size: response instanceof Blob ? response.size : null,
            promise: response instanceof Blob && typeof response.text === 'function'
              ? response.text().then(text => ({status: 'resolved', text}), error => ({status: 'rejected', errorName: error.name}))
              : Promise.resolve({status: 'unsupported'})
          };
        }
        if (responseType === 'document') {
          const response = xhr.response;
          return {
            kind: 'Document',
            isDocument: response instanceof Document,
            sameIdentity: response === xhr.response,
            responseXmlSameIdentity: response === xhr.responseXML,
            title: response instanceof Document ? response.title : null,
            bodyText: response instanceof Document ? response.body?.textContent?.trim() ?? null : null,
            url: response instanceof Document ? response.URL : null
          };
        }
        if (responseType === 'json') {
          const response = xhr.response;
          return {
            kind: 'JSON',
            sameIdentity: response === xhr.response,
            value: response
          };
        }
        return {
          kind: 'text',
          text: xhr.responseText,
          sameIdentity: xhr.response === xhr.responseText
        };
      }

      async function readValue(xhr, responseType) {
        const value = valueOf(xhr, responseType);
        if (responseType === 'blob') value.text = await value.promise;
        delete value.promise;
        return value;
      }

      async function request(options) {
        const xhr = new XMLHttpRequest();
        const events = observe(xhr);
        const done = terminalPromise(xhr);
        if (options.overrideMimeType !== undefined) xhr.overrideMimeType(options.overrideMimeType);
        xhr.open(options.method ?? 'GET', options.url, true);
        if (options.timeout !== undefined) xhr.timeout = options.timeout;
        if (options.responseType !== undefined) xhr.responseType = options.responseType;
        if (options.configure) options.configure(xhr);
        const afterOpenAndConfigure = snapshot(xhr);
        xhr.send(options.body === undefined ? null : options.body);
        const terminal = await done;
        return {
          terminal,
          afterOpenAndConfigure,
          final: snapshot(xhr),
          events,
          value: await readValue(xhr, xhr.responseType)
        };
      }

      function wait(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
      }

      function errorResult(operation) {
        try {
          operation();
          return {status: 'ok'};
        } catch (error) {
          return {status: 'throws', errorName: error.name, message: String(error.message || error)};
        }
      }

      async function abortOnLoadStart() {
        const xhr = new XMLHttpRequest();
        const events = observe(xhr);
        const done = terminalPromise(xhr);
        xhr.addEventListener('loadstart', () => xhr.abort());
        xhr.open('GET', '/slow-stream?case=abort-loadstart&delay=250', true);
        xhr.send();
        const terminal = await done;
        return {terminal, final: snapshot(xhr), events};
      }

      async function abortDuringLoading() {
        const xhr = new XMLHttpRequest();
        const events = observe(xhr);
        const done = terminalPromise(xhr);
        let aborted = false;
        xhr.addEventListener('readystatechange', () => {
          if (!aborted && xhr.readyState === XMLHttpRequest.LOADING) {
            aborted = true;
            xhr.abort();
          }
        });
        xhr.open('GET', '/slow-stream?case=abort-loading&delay=400', true);
        xhr.send();
        const terminal = await done;
        return {aborted, terminal, final: snapshot(xhr), events};
      }

      async function repeatedSend() {
        const xhr = new XMLHttpRequest();
        const events = observe(xhr);
        const done = terminalPromise(xhr);
        xhr.open('GET', '/delay?case=repeated-send&ms=100', true);
        xhr.send();
        const secondSend = errorResult(() => xhr.send());
        const terminal = await done;
        return {secondSend, terminal, final: snapshot(xhr), events};
      }

      async function timeoutChanged(initialTimeout, replacementTimeout, label) {
        const xhr = new XMLHttpRequest();
        const events = observe(xhr);
        const done = terminalPromise(xhr);
        xhr.open('GET', '/delay?case=' + encodeURIComponent(label) + '&ms=150', true);
        xhr.timeout = initialTimeout;
        xhr.send();
        await wait(10);
        const beforeChange = snapshot(xhr);
        xhr.timeout = replacementTimeout;
        const afterChange = snapshot(xhr);
        const terminal = await done;
        return {initialTimeout, beforeChange, afterChange, terminal, final: snapshot(xhr), events};
      }

      async function reopenWhileLoading() {
        const xhr = new XMLHttpRequest();
        const events = observe(xhr);
        let didReopen = false;
        const completed = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Reopened XHR did not finish')), 10000);
          xhr.addEventListener('loadend', () => {
            if (didReopen && xhr.readyState === XMLHttpRequest.DONE && xhr.responseText === 'XHR 中文 text') {
              clearTimeout(timer);
              resolve();
            }
          });
        });
        xhr.open('GET', '/slow-stream?case=reopen-old&delay=500', true);
        xhr.send();
        await wait(20);
        didReopen = true;
        xhr.open('GET', '/text?case=reopen-new', true);
        const afterReopen = snapshot(xhr);
        xhr.send();
        await completed;
        return {afterReopen, final: snapshot(xhr), responseText: xhr.responseText, events};
      }

      async function reenterFrom(phase) {
        const xhr = new XMLHttpRequest();
        const events = observe(xhr);
        let reentered = false;
        let reentryError = null;
        const completed = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Reentrant XHR did not finish at ' + phase)), 10000);
          xhr.addEventListener('loadend', () => {
            if (reentered && xhr.readyState === XMLHttpRequest.DONE && xhr.responseText === 'XHR 中文 text') {
              clearTimeout(timer);
              resolve();
            }
          });
        });
        const reenter = () => {
          if (reentered) return;
          reentered = true;
          try {
            xhr.open('GET', '/text?case=reentry-second-' + phase, true);
            xhr.send();
          } catch (error) {
            reentryError = {errorName: error.name, message: String(error.message || error)};
          }
        };
        if (phase === 'readystatechange') {
          xhr.addEventListener('readystatechange', () => {
            if (xhr.readyState === XMLHttpRequest.DONE && !reentered) reenter();
          });
        } else if (phase === 'load') {
          xhr.addEventListener('load', () => { if (!reentered) reenter(); });
        } else if (phase === 'loadend') {
          xhr.addEventListener('loadend', () => { if (!reentered) reenter(); });
        }
        xhr.open('GET', '/text?case=reentry-first-' + phase, true);
        xhr.send();
        await completed;
        return {phase, reentryError, final: snapshot(xhr), responseText: xhr.responseText, events};
      }

      async function listenerTriggeredPreflight(corsUrl) {
        const xhr = new XMLHttpRequest();
        const events = observe(xhr);
        let headerResult = null;
        let setOnce = false;
        xhr.addEventListener('readystatechange', () => {
          if (!setOnce && xhr.readyState === XMLHttpRequest.OPENED) {
            setOnce = true;
            headerResult = errorResult(() => xhr.setRequestHeader('X-Trace', 'from-opened-listener'));
          }
        });
        const done = terminalPromise(xhr);
        xhr.open('GET', corsUrl, true);
        xhr.send();
        const terminal = await done;
        return {headerResult, terminal, final: snapshot(xhr), responseText: xhr.responseText, events};
      }

      async function uploadSimplePreflight(corsUrl) {
        const xhr = new XMLHttpRequest();
        const events = observe(xhr);
        const uploadEvents = [];
        const done = terminalPromise(xhr);
        const listenerRegistration = errorResult(() => {
          xhr.upload.addEventListener('progress', event => uploadEvents.push({
            type: event.type,
            loaded: event.loaded,
            total: event.total,
            lengthComputable: event.lengthComputable
          }));
        });
        xhr.open('POST', corsUrl, true);
        xhr.setRequestHeader('Content-Type', 'text/plain');
        xhr.send('upload body');
        const terminal = await done;
        return {
          listenerRegistration,
          uploadEvents,
          terminal,
          final: snapshot(xhr),
          responseText: xhr.responseText,
          events
        };
      }

      async function run() {
        const alternateHost = location.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
        const crossUrl = pathname => {
          const url = new URL(location.href);
          url.hostname = alternateHost;
          url.pathname = pathname;
          url.search = '';
          url.hash = '';
          return url.href;
        };
        const result = {
          fixture: 'document-xhr-v1',
          origin: location.origin,
          alternateHost,
          requests: {},
          cases: {},
          errors: {},
          reentry: {}
        };

        result.requests.getText = await request({url: '/text'});
        result.requests.postJson = await request({
          method: 'POST',
          url: '/post-json',
          responseType: 'json',
          body: JSON.stringify({city: '台北', count: 2}),
          configure(xhr) {
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.setRequestHeader('X-Trace', 'first');
            xhr.setRequestHeader('X-Trace', 'second');
            result.cases.forbiddenHeaderSet = {
              cookie: errorResult(() => xhr.setRequestHeader('Cookie', 'blocked=1')),
              host: errorResult(() => xhr.setRequestHeader('Host', 'forbidden.invalid'))
            };
          }
        });
        result.requests.status404 = await request({url: '/status404'});
        result.requests.validJson = await request({url: '/json-valid', responseType: 'json'});
        result.requests.invalidJson = await request({url: '/json-invalid', responseType: 'json'});
        result.requests.arrayBuffer = await request({url: '/arraybuffer', responseType: 'arraybuffer'});
        result.requests.blob = await request({url: '/blob', responseType: 'blob'});
        result.requests.document = await request({url: '/document-response', responseType: 'document'});
        result.requests.overrideMimeType = await request({
          url: '/windows-1252',
          overrideMimeType: 'text/plain; charset=windows-1252'
        });
        result.requests.redirect = await request({url: '/redirect-text'});
        result.requests.empty204 = await request({url: '/empty204'});
        result.requests.head = await request({method: 'HEAD', url: '/head'});

        const corsAllow = await request({url: crossUrl('/cors-allow')});
        result.requests.corsAllow = corsAllow;
        result.requests.corsDeny = await request({url: crossUrl('/cors-deny')});
        result.requests.listenerTriggeredPreflight = await listenerTriggeredPreflight(crossUrl('/cors-preflight'));
        result.requests.uploadSimplePreflight = await uploadSimplePreflight(crossUrl('/upload-simple'));

        result.cases.abortDuringLoadstart = await abortOnLoadStart();
        result.cases.abortDuringLoading = await abortDuringLoading();
        result.cases.repeatedSend = await repeatedSend();
        result.cases.timeout = await request({url: '/delay?case=timeout&ms=150', timeout: 25});
        result.cases.timeoutShortThenLong = await timeoutChanged(25, 500, 'timeout-short-then-long');
        result.cases.timeoutLongThenShort = await timeoutChanged(500, 25, 'timeout-long-then-short');
        result.cases.reopenWhileLoading = await reopenWhileLoading();
        for (const phase of ['readystatechange', 'load', 'loadend']) {
          result.reentry[phase] = await reenterFrom(phase);
        }

        result.errors.openForbiddenMethods = Object.fromEntries(['TRACE', 'TRACK', 'CONNECT'].map(method => {
          const xhr = new XMLHttpRequest();
          return [method, errorResult(() => xhr.open(method, '/text', true))];
        }));
        const beforeOpenHeaderXhr = new XMLHttpRequest();
        result.errors.setRequestHeaderBeforeOpen = errorResult(
          () => beforeOpenHeaderXhr.setRequestHeader('X-Trace', 'early'),
        );
        return result;
      }

      const fixture = {result: null, ready: null};
      window.__documentXhrFixture = fixture;
      fixture.ready = run().then(result => {
        fixture.result = result;
        resultNode.textContent = JSON.stringify(result);
        visibleNode.textContent = 'XMLHttpRequest parity probes complete.';
        return result;
      }).catch(error => {
        const failure = {fixture: 'document-xhr-v1', fixtureError: error && error.message || String(error)};
        fixture.result = failure;
        resultNode.textContent = JSON.stringify(failure);
        visibleNode.textContent = 'XMLHttpRequest parity probe failed.';
        return failure;
      });
    })();
  </script>
</body>
</html>''';
