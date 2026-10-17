const binaryFetchResponseText = '{"ok":true,"label":"BINARY_FETCH_OK"}';
const binaryFetchUploadPath = '/upload';
const binaryFetchBinaryFileBytes = <int>[0, 127, 128, 255, 13, 10];
const binaryFetchBinaryFileName = '城市.bin';
const binaryFetchBlobFileName = 'note.txt';
const binaryFetchBlobText = 'text尾';
const binaryFetchExpectedWireEntries = <Map<String, Object?>>[
  <String, Object?>{'name': 'city', 'kind': 'text', 'value': '城市'},
  <String, Object?>{'name': 'dup', 'kind': 'text', 'value': 'first'},
  <String, Object?>{'name': 'dup', 'kind': 'text', 'value': 'second'},
  <String, Object?>{
    'name': 'message',
    'kind': 'text',
    'value': 'first line\r\nsecond line',
  },
  <String, Object?>{'name': 'choice', 'kind': 'text', 'value': 'yes'},
  <String, Object?>{
    'name': 'upload',
    'kind': 'file',
    'filename': '',
    'mimeType': 'application/octet-stream',
    'size': 0,
    'base64': '',
  },
  <String, Object?>{'name': 'go', 'kind': 'text', 'value': 'yes'},
  <String, Object?>{'name': 'hook', 'kind': 'text', 'value': 'from-event'},
  <String, Object?>{
    'name': 'binary',
    'kind': 'file',
    'filename': '城市.bin',
    'mimeType': 'application/octet-stream',
    'size': 6,
    'base64': 'AH+A/w0K',
  },
  <String, Object?>{
    'name': 'blob',
    'kind': 'file',
    'filename': 'note.txt',
    'mimeType': 'text/plain',
    'size': 7,
    'base64': 'dGV4dOWwvg==',
  },
  <String, Object?>{'name': 'dup', 'kind': 'text', 'value': 'third'},
  <String, Object?>{'name': 'dup', 'kind': 'text', 'value': 'fourth'},
];

const binaryFetchHtml = r'''<!doctype html>
<html>
<head><meta charset="utf-8"><title>Binary fetch fixture</title></head>
<body>
  <form id="upload-form" action="./upload" method="post" enctype="multipart/form-data">
    <label>City <input name="city" value="城市"></label>
    <input name="dup" value="first">
    <input name="dup" value="second">
    <label>Message <textarea name="message">first line
second line</textarea></label>
    <label><input type="checkbox" name="choice" value="yes" checked>Checked</label>
    <label><input type="checkbox" name="unchecked" value="no">Unchecked</label>
    <input name="disabled" value="must-not-be-sent" disabled>
    <input id="upload" type="file" name="upload" multiple>
    <button id="not-submit" type="button">Do not submit</button>
    <button id="send" type="submit" name="go" value="yes">Send upload</button>
    <button id="other-submit" type="submit" name="other" value="no">Other submitter</button>
  </form>
  <p id="result">WAITING</p>
  <pre id="clone-result">WAITING</pre>
<script>
const form = document.querySelector('#upload-form');
const output = document.querySelector('#result');
const cloneOutput = document.querySelector('#clone-result');

function encodeBase64(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)];
    encoded += second === undefined
      ? '='
      : alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)];
    encoded += third === undefined ? '=' : alphabet[third & 63];
  }
  return encoded;
}

form.addEventListener('formdata', event => {
  event.formData.append('hook', 'from-event');
});

async function summarizeFormData(formData) {
  const entries = [];
  for (const [name, value] of formData.entries()) {
    if (typeof value === 'string') {
      entries.push({name, kind: 'text', value});
      continue;
    }
    const bytes = Array.from(new Uint8Array(await value.arrayBuffer()));
    const entry = {
      name,
      kind: 'file',
      filename: value.name,
      mimeType: value.type,
      size: value.size,
      base64: encodeBase64(bytes)
    };
    entries.push(entry);
  }
  return entries;
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  output.textContent = 'RUNNING';
  try {
    const data = new FormData(form, event.submitter);
    data.append('binary', new File([
      new Uint8Array([0, 127, 128, 255, 13, 10]),
    ],
      '城市.bin',
      {type: 'application/octet-stream', lastModified: 123}
    ));
    data.append('blob', new Blob(['text尾'], {type: 'text/plain'}), 'note.txt');
    data.append('dup', 'third');
    data.append('dup', 'fourth');
    const sourceBinary = data.get('binary');

    const snapshotRequest = new Request('./upload', {
      method: 'POST',
      body: data
    });
    data.append('afterRequest', 'must-not-be-sent');

    const cloneData = await snapshotRequest.clone().formData();
    const cloneEntries = await summarizeFormData(cloneData);
    window.__binaryFetchSnapshot = {
      method: snapshotRequest.method,
      path: new URL(snapshotRequest.url).pathname,
      credentials: snapshotRequest.credentials,
      sourceBinary: {
        name: sourceBinary.name,
        type: sourceBinary.type,
        size: sourceBinary.size,
        lastModified: sourceBinary.lastModified
      },
      cloneEntries,
      afterRequestMutationIncluded: cloneData.has('afterRequest')
    };
    cloneOutput.textContent = JSON.stringify(cloneEntries);

    const response = await fetch(snapshotRequest);
    const responseBlob = await response.clone().blob();
    const responseText = await responseBlob.text();
    window.__binaryFetchSnapshot.responseStatus = response.status;
    window.__binaryFetchSnapshot.responseText = responseText;
    output.textContent = responseText;
  } catch (error) {
    window.__binaryFetchError = String(error && error.stack || error);
    output.textContent = 'ERROR: ' + String(error && error.message || error);
  }
});
</script>
</body>
</html>''';
