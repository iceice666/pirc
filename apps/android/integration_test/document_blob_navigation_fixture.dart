// Shared parent document used by the Chrome oracle and the native runtime.
const blobNavigationHtml =
    r'''<!doctype html><html><head><meta charset="utf-8"><title>Blob document navigation</title></head><body>
<h1>Blob document navigation</h1>
<button id="prepare-blob-links" type="button">Prepare blob navigation links</button>
<ul>
  <li><a id="html-self" target="_self" href="#">HTML self</a></li>
  <li><a id="html-blank" target="_blank" href="#">HTML blank</a></li>
  <li><a id="html-named" target="blob-navigation-named" href="#">HTML named</a></li>
  <li><a id="html-named-second" target="blob-navigation-named" href="#">HTML named second</a></li>
  <li><a id="html-base-self" target="_self" href="#">HTML with base</a></li>
  <li><a id="html-no-charset-self" target="_self" href="#">HTML without charset</a></li>
  <li><a id="html-charset-self" target="_self" href="#">HTML UTF-8 charset</a></li>
  <li><a id="empty-self" target="_self" href="#">Empty MIME HTML bytes</a></li>
  <li><a id="octet-self" target="_self" href="#">Octet stream HTML bytes</a></li>
  <li><a id="plain-charset-self" target="_self" href="#">Plain UTF-8 charset</a></li>
  <li><a id="plain-self" target="_self" href="#">Plain self</a></li>
  <li><a id="plain-blank" target="_blank" href="#">Plain blank</a></li>
  <li><a id="plain-named" target="blob-navigation-named" href="#">Plain named</a></li>
  <li><a id="image-self" target="_self" href="#">Image self</a></li>
  <li><a id="image-blank" target="_blank" href="#">Image blank</a></li>
  <li><a id="image-named" target="blob-navigation-named" href="#">Image named</a></li>
</ul>
<pre id="blob-navigation-result">WAITING</pre>
<script>
(() => {
  const resultNode = document.querySelector('#blob-navigation-result');
  const redPng = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0,
    13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0,
    1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
  ]);

  function htmlSource(withBase, includeMeta = true) {
    const base = withBase ? '<base href="' + location.origin + '/base/">' : '';
    const meta = includeMeta ? '<meta charset="utf-8">' : '';
    const script = [
      'const creatorOrigin=' + JSON.stringify(location.origin) + ';',
      'const creatorUrl=' + JSON.stringify(location.href) + ';',
      'const read=async href=>{try{const r=await fetch(href);return {ok:true,status:r.status,text:await r.text()}}catch(e){return {ok:false,errorName:e.name}}};',
      '(async()=>{',
      'const initialHref=location.href;',
      'const initialOrigin=location.origin;',
      'const initialBaseURI=document.baseURI;',
      'const relativeFetch=await read("relative.txt");',
      'const absoluteFetch=await read(creatorOrigin+"/absolute.txt");',
      'const core={urlScheme:new URL(initialHref).protocol.slice(0,-1),originMatchesCreator:initialOrigin===creatorOrigin,baseUriIsBlob:initialBaseURI.startsWith("blob:"),baseHrefApplied:initialBaseURI.startsWith(creatorOrigin+"/base/"),relativeFetch,absoluteFetch,referrerMatchesCreator:document.referrer===creatorUrl};',
      'document.querySelector("#blob-navigation-core-result").textContent=JSON.stringify(core);',
      'const historySupported=typeof history!=="undefined"&&typeof history.pushState==="function";',
      'const beforeHistoryLength=historySupported?history.length:0;',
      'let pushStateError=null;',
      'if(historySupported){try{history.pushState({probe:"blob-navigation"},"","#history-probe")}catch(e){pushStateError=e.name}}else{pushStateError="Unsupported"}',
      'const openerPresent=typeof window.opener!=="undefined"&&window.opener!==null;',
      'let openerCanReadSameOrigin=null;',
      'if(openerPresent){try{openerCanReadSameOrigin=window.opener.location.origin===creatorOrigin}catch(e){openerCanReadSameOrigin=false}}',
      'document.querySelector("#blob-navigation-result").textContent=JSON.stringify({...core,openerPresent,openerCanReadSameOrigin,windowName:window.name,history:{supported:historySupported,lengthIncreased:historySupported&&history.length===beforeHistoryLength+1,pushStateError,originPreserved:location.origin===creatorOrigin,fragmentApplied:location.hash==="#history-probe"}});',
      '})();'
    ].join('');
    return '<!doctype html><html><head>' + meta + '<title>Blob child</title>' +
      base + '</head><body><h1>Blob child document 雪 café</h1>' +
      '<pre id="blob-navigation-core-result">CORE_LOADING</pre><pre id="blob-navigation-result">LOADING</pre><script>' + script + '<\/script></body></html>';
  }

  document.querySelector('#prepare-blob-links').addEventListener('click', () => {
    const htmlUrl = URL.createObjectURL(new Blob([htmlSource(false)], {type: 'text/html'}));
    const baseHtmlUrl = URL.createObjectURL(new Blob([htmlSource(true)], {type: 'text/html'}));
    const plainUrl = URL.createObjectURL(new Blob(['Blob plain text café 雪'], {type: 'text/plain'}));
    const imageUrl = URL.createObjectURL(new Blob([redPng], {type: 'image/png'}));
    const htmlNoCharsetUrl = URL.createObjectURL(new Blob([htmlSource(false, false)], {type: 'text/html'}));
    const htmlCharsetUrl = URL.createObjectURL(new Blob([htmlSource(false, false)], {type: 'text/html;charset=utf-8'}));
    const emptyMimeUrl = URL.createObjectURL(new Blob([htmlSource(false, false)]));
    const octetStreamUrl = URL.createObjectURL(new Blob([htmlSource(false, false)], {type: 'application/octet-stream'}));
    const plainCharsetUrl = URL.createObjectURL(new Blob(['Blob plain text café 雪'], {type: 'text/plain;charset=utf-8'}));
    window.__blobNavigationUrls = {htmlUrl, baseHtmlUrl, plainUrl, imageUrl, htmlNoCharsetUrl, htmlCharsetUrl, emptyMimeUrl, octetStreamUrl, plainCharsetUrl};
    for (const id of ['html-self', 'html-blank', 'html-named']) {
      document.querySelector('#' + id).setAttribute('href', htmlUrl);
    }
    document.querySelector('#html-named-second').setAttribute('href', baseHtmlUrl);
    document.querySelector('#html-base-self').setAttribute('href', baseHtmlUrl);
    document.querySelector('#html-no-charset-self').setAttribute('href', htmlNoCharsetUrl);
    document.querySelector('#html-charset-self').setAttribute('href', htmlCharsetUrl);
    document.querySelector('#empty-self').setAttribute('href', emptyMimeUrl);
    document.querySelector('#octet-self').setAttribute('href', octetStreamUrl);
    document.querySelector('#plain-charset-self').setAttribute('href', plainCharsetUrl);
    for (const id of ['plain-self', 'plain-blank', 'plain-named']) {
      document.querySelector('#' + id).setAttribute('href', plainUrl);
    }
    for (const id of ['image-self', 'image-blank', 'image-named']) {
      document.querySelector('#' + id).setAttribute('href', imageUrl);
    }
    resultNode.textContent = JSON.stringify({
      originIsHttp: location.protocol === 'http:',
      htmlUrlHasBlobOrigin: htmlUrl.startsWith('blob:' + location.origin + '/'),
      baseHtmlUrlHasBlobOrigin: baseHtmlUrl.startsWith('blob:' + location.origin + '/'),
      plainUrlHasBlobOrigin: plainUrl.startsWith('blob:' + location.origin + '/'),
      imageUrlHasBlobOrigin: imageUrl.startsWith('blob:' + location.origin + '/'),
      htmlNoCharsetUrlHasBlobOrigin: htmlNoCharsetUrl.startsWith('blob:' + location.origin + '/'),
      htmlCharsetUrlHasBlobOrigin: htmlCharsetUrl.startsWith('blob:' + location.origin + '/'),
      emptyMimeUrlHasBlobOrigin: emptyMimeUrl.startsWith('blob:' + location.origin + '/'),
      octetStreamUrlHasBlobOrigin: octetStreamUrl.startsWith('blob:' + location.origin + '/'),
      plainCharsetUrlHasBlobOrigin: plainCharsetUrl.startsWith('blob:' + location.origin + '/'),
      targetsReady: document.querySelector('#html-self').target === '_self' &&
        document.querySelector('#html-blank').target === '_blank' &&
        document.querySelector('#html-named').target === 'blob-navigation-named'
    });
  });
})();
</script></body></html>''';

const blobNavigationCoreExpectedJson =
    r'''{"urlScheme":"blob","originMatchesCreator":true,"baseUriIsBlob":true,"baseHrefApplied":false,"relativeFetch":{"ok":false,"errorName":"TypeError"},"absoluteFetch":{"ok":true,"status":200,"text":"ABSOLUTE_BLOB_FETCH_OK"},"referrerMatchesCreator":true}''';

const blobNavigationBaseCoreExpectedJson =
    r'''{"urlScheme":"blob","originMatchesCreator":true,"baseUriIsBlob":false,"baseHrefApplied":true,"relativeFetch":{"ok":true,"status":200,"text":"BASE_RELATIVE_FETCH_OK"},"absoluteFetch":{"ok":true,"status":200,"text":"ABSOLUTE_BLOB_FETCH_OK"},"referrerMatchesCreator":true}''';

const blobNavigationExpectedJson = r'''{
  "parentSetup": {
    "originIsHttp": true,
    "htmlUrlHasBlobOrigin": true,
    "baseHtmlUrlHasBlobOrigin": true,
    "plainUrlHasBlobOrigin": true,
    "imageUrlHasBlobOrigin": true,
    "htmlNoCharsetUrlHasBlobOrigin": true,
    "htmlCharsetUrlHasBlobOrigin": true,
    "emptyMimeUrlHasBlobOrigin": true,
    "octetStreamUrlHasBlobOrigin": true,
    "plainCharsetUrlHasBlobOrigin": true,
    "targetsReady": true
  },
  "navigations": {
    "html": {
      "self": {
        "target": "self",
        "samePage": true,
        "hrefScheme": "blob",
        "snapshot": {
          "urlScheme": "blob",
          "originMatchesLoopback": true,
          "contentType": "text/html",
          "characterSet": "UTF-8",
          "baseUriKind": "blob",
          "baseHrefPath": null,
          "referrerMatchesFixture": true,
          "name": "",
          "openerPresent": false,
          "openerReadableSameOrigin": null,
          "title": "Blob child",
          "imageViewerTitleHasDimensions": null,
          "textPlain": null,
          "textPlainIsHtmlSource": null,
          "htmlUnicodeTextPresent": true,
          "image": null
        },
        "coreResult": {
          "urlScheme": "blob",
          "originMatchesCreator": true,
          "baseUriIsBlob": true,
          "baseHrefApplied": false,
          "relativeFetch": {
            "ok": false,
            "errorName": "TypeError"
          },
          "absoluteFetch": {
            "ok": true,
            "status": 200,
            "text": "ABSOLUTE_BLOB_FETCH_OK"
          },
          "referrerMatchesCreator": true
        },
        "htmlResult": {
          "urlScheme": "blob",
          "originMatchesCreator": true,
          "baseUriIsBlob": true,
          "baseHrefApplied": false,
          "relativeFetch": {
            "ok": false,
            "errorName": "TypeError"
          },
          "absoluteFetch": {
            "ok": true,
            "status": 200,
            "text": "ABSOLUTE_BLOB_FETCH_OK"
          },
          "referrerMatchesCreator": true,
          "openerPresent": false,
          "openerCanReadSameOrigin": null,
          "windowName": "",
          "history": {
            "supported": true,
            "lengthIncreased": true,
            "pushStateError": null,
            "originPreserved": true,
            "fragmentApplied": true
          }
        }
      },
      "blank": {
        "target": "blank",
        "samePage": false,
        "hrefScheme": "blob",
        "snapshot": {
          "urlScheme": "blob",
          "originMatchesLoopback": true,
          "contentType": "text/html",
          "characterSet": "UTF-8",
          "baseUriKind": "blob",
          "baseHrefPath": null,
          "referrerMatchesFixture": true,
          "name": "",
          "openerPresent": false,
          "openerReadableSameOrigin": null,
          "title": "Blob child",
          "imageViewerTitleHasDimensions": null,
          "textPlain": null,
          "textPlainIsHtmlSource": null,
          "htmlUnicodeTextPresent": true,
          "image": null
        },
        "coreResult": {
          "urlScheme": "blob",
          "originMatchesCreator": true,
          "baseUriIsBlob": true,
          "baseHrefApplied": false,
          "relativeFetch": {
            "ok": false,
            "errorName": "TypeError"
          },
          "absoluteFetch": {
            "ok": true,
            "status": 200,
            "text": "ABSOLUTE_BLOB_FETCH_OK"
          },
          "referrerMatchesCreator": true
        },
        "htmlResult": {
          "urlScheme": "blob",
          "originMatchesCreator": true,
          "baseUriIsBlob": true,
          "baseHrefApplied": false,
          "relativeFetch": {
            "ok": false,
            "errorName": "TypeError"
          },
          "absoluteFetch": {
            "ok": true,
            "status": 200,
            "text": "ABSOLUTE_BLOB_FETCH_OK"
          },
          "referrerMatchesCreator": true,
          "openerPresent": false,
          "openerCanReadSameOrigin": null,
          "windowName": "",
          "history": {
            "supported": true,
            "lengthIncreased": true,
            "pushStateError": null,
            "originPreserved": true,
            "fragmentApplied": true
          }
        }
      },
      "named": {
        "target": "named",
        "samePage": false,
        "hrefScheme": "blob",
        "snapshot": {
          "urlScheme": "blob",
          "originMatchesLoopback": true,
          "contentType": "text/html",
          "characterSet": "UTF-8",
          "baseUriKind": "blob",
          "baseHrefPath": null,
          "referrerMatchesFixture": true,
          "name": "blob-navigation-named",
          "openerPresent": true,
          "openerReadableSameOrigin": true,
          "title": "Blob child",
          "imageViewerTitleHasDimensions": null,
          "textPlain": null,
          "textPlainIsHtmlSource": null,
          "htmlUnicodeTextPresent": true,
          "image": null
        },
        "coreResult": {
          "urlScheme": "blob",
          "originMatchesCreator": true,
          "baseUriIsBlob": true,
          "baseHrefApplied": false,
          "relativeFetch": {
            "ok": false,
            "errorName": "TypeError"
          },
          "absoluteFetch": {
            "ok": true,
            "status": 200,
            "text": "ABSOLUTE_BLOB_FETCH_OK"
          },
          "referrerMatchesCreator": true
        },
        "htmlResult": {
          "urlScheme": "blob",
          "originMatchesCreator": true,
          "baseUriIsBlob": true,
          "baseHrefApplied": false,
          "relativeFetch": {
            "ok": false,
            "errorName": "TypeError"
          },
          "absoluteFetch": {
            "ok": true,
            "status": 200,
            "text": "ABSOLUTE_BLOB_FETCH_OK"
          },
          "referrerMatchesCreator": true,
          "openerPresent": true,
          "openerCanReadSameOrigin": true,
          "windowName": "blob-navigation-named",
          "history": {
            "supported": true,
            "lengthIncreased": true,
            "pushStateError": null,
            "originPreserved": true,
            "fragmentApplied": true
          }
        }
      }
    },
    "plain": {
      "self": {
        "target": "self",
        "samePage": true,
        "hrefScheme": "blob",
        "snapshot": {
          "urlScheme": "blob",
          "originMatchesLoopback": true,
          "contentType": "text/plain",
          "characterSet": "Big5",
          "baseUriKind": "blob",
          "baseHrefPath": null,
          "referrerMatchesFixture": true,
          "name": "",
          "openerPresent": false,
          "openerReadableSameOrigin": null,
          "title": "",
          "imageViewerTitleHasDimensions": null,
          "textPlain": "Blob plain text caf矇 ��",
          "textPlainIsHtmlSource": false,
          "htmlUnicodeTextPresent": null,
          "image": null
        },
        "coreResult": null,
        "htmlResult": null
      },
      "blank": {
        "target": "blank",
        "samePage": false,
        "hrefScheme": "blob",
        "snapshot": {
          "urlScheme": "blob",
          "originMatchesLoopback": true,
          "contentType": "text/plain",
          "characterSet": "Big5",
          "baseUriKind": "blob",
          "baseHrefPath": null,
          "referrerMatchesFixture": true,
          "name": "",
          "openerPresent": false,
          "openerReadableSameOrigin": null,
          "title": "",
          "imageViewerTitleHasDimensions": null,
          "textPlain": "Blob plain text caf矇 ��",
          "textPlainIsHtmlSource": false,
          "htmlUnicodeTextPresent": null,
          "image": null
        },
        "coreResult": null,
        "htmlResult": null
      },
      "named": {
        "target": "named",
        "samePage": false,
        "hrefScheme": "blob",
        "snapshot": {
          "urlScheme": "blob",
          "originMatchesLoopback": true,
          "contentType": "text/plain",
          "characterSet": "Big5",
          "baseUriKind": "blob",
          "baseHrefPath": null,
          "referrerMatchesFixture": true,
          "name": "blob-navigation-named",
          "openerPresent": true,
          "openerReadableSameOrigin": true,
          "title": "",
          "imageViewerTitleHasDimensions": null,
          "textPlain": "Blob plain text caf矇 ��",
          "textPlainIsHtmlSource": false,
          "htmlUnicodeTextPresent": null,
          "image": null
        },
        "coreResult": null,
        "htmlResult": null
      }
    },
    "image": {
      "self": {
        "target": "self",
        "samePage": true,
        "hrefScheme": "blob",
        "snapshot": {
          "urlScheme": "blob",
          "originMatchesLoopback": true,
          "contentType": "image/png",
          "characterSet": "UTF-8",
          "baseUriKind": "blob",
          "baseHrefPath": null,
          "referrerMatchesFixture": true,
          "name": "",
          "openerPresent": false,
          "openerReadableSameOrigin": null,
          "title": null,
          "imageViewerTitleHasDimensions": true,
          "textPlain": null,
          "textPlainIsHtmlSource": null,
          "htmlUnicodeTextPresent": null,
          "image": {
            "count": 1,
            "srcIsBlob": true,
            "width": 1,
            "height": 1
          }
        },
        "coreResult": null,
        "htmlResult": null
      },
      "blank": {
        "target": "blank",
        "samePage": false,
        "hrefScheme": "blob",
        "snapshot": {
          "urlScheme": "blob",
          "originMatchesLoopback": true,
          "contentType": "image/png",
          "characterSet": "UTF-8",
          "baseUriKind": "blob",
          "baseHrefPath": null,
          "referrerMatchesFixture": true,
          "name": "",
          "openerPresent": false,
          "openerReadableSameOrigin": null,
          "title": null,
          "imageViewerTitleHasDimensions": true,
          "textPlain": null,
          "textPlainIsHtmlSource": null,
          "htmlUnicodeTextPresent": null,
          "image": {
            "count": 1,
            "srcIsBlob": true,
            "width": 1,
            "height": 1
          }
        },
        "coreResult": null,
        "htmlResult": null
      },
      "named": {
        "target": "named",
        "samePage": false,
        "hrefScheme": "blob",
        "snapshot": {
          "urlScheme": "blob",
          "originMatchesLoopback": true,
          "contentType": "image/png",
          "characterSet": "UTF-8",
          "baseUriKind": "blob",
          "baseHrefPath": null,
          "referrerMatchesFixture": true,
          "name": "blob-navigation-named",
          "openerPresent": true,
          "openerReadableSameOrigin": true,
          "title": null,
          "imageViewerTitleHasDimensions": true,
          "textPlain": null,
          "textPlainIsHtmlSource": null,
          "htmlUnicodeTextPresent": null,
          "image": {
            "count": 1,
            "srcIsBlob": true,
            "width": 1,
            "height": 1
          }
        },
        "coreResult": null,
        "htmlResult": null
      }
    }
  },
  "mimeCases": {
    "htmlNoCharset": {
      "target": "self",
      "samePage": true,
      "hrefScheme": "blob",
      "snapshot": {
        "urlScheme": "blob",
        "originMatchesLoopback": true,
        "contentType": "text/html",
        "characterSet": "Big5",
        "baseUriKind": "blob",
        "baseHrefPath": null,
        "referrerMatchesFixture": true,
        "name": "",
        "openerPresent": false,
        "openerReadableSameOrigin": null,
        "title": "Blob child",
        "imageViewerTitleHasDimensions": null,
        "textPlain": null,
        "textPlainIsHtmlSource": null,
        "htmlUnicodeTextPresent": false,
        "image": null
      },
      "coreResult": {
        "urlScheme": "blob",
        "originMatchesCreator": true,
        "baseUriIsBlob": true,
        "baseHrefApplied": false,
        "relativeFetch": {
          "ok": false,
          "errorName": "TypeError"
        },
        "absoluteFetch": {
          "ok": true,
          "status": 200,
          "text": "ABSOLUTE_BLOB_FETCH_OK"
        },
        "referrerMatchesCreator": true
      },
      "htmlResult": {
        "urlScheme": "blob",
        "originMatchesCreator": true,
        "baseUriIsBlob": true,
        "baseHrefApplied": false,
        "relativeFetch": {
          "ok": false,
          "errorName": "TypeError"
        },
        "absoluteFetch": {
          "ok": true,
          "status": 200,
          "text": "ABSOLUTE_BLOB_FETCH_OK"
        },
        "referrerMatchesCreator": true,
        "openerPresent": false,
        "openerCanReadSameOrigin": null,
        "windowName": "",
        "history": {
          "supported": true,
          "lengthIncreased": true,
          "pushStateError": null,
          "originPreserved": true,
          "fragmentApplied": true
        }
      }
    },
    "htmlUtf8Charset": {
      "target": "self",
      "samePage": true,
      "hrefScheme": "blob",
      "snapshot": {
        "urlScheme": "blob",
        "originMatchesLoopback": true,
        "contentType": "text/html",
        "characterSet": "UTF-8",
        "baseUriKind": "blob",
        "baseHrefPath": null,
        "referrerMatchesFixture": true,
        "name": "",
        "openerPresent": false,
        "openerReadableSameOrigin": null,
        "title": "Blob child",
        "imageViewerTitleHasDimensions": null,
        "textPlain": null,
        "textPlainIsHtmlSource": null,
        "htmlUnicodeTextPresent": true,
        "image": null
      },
      "coreResult": {
        "urlScheme": "blob",
        "originMatchesCreator": true,
        "baseUriIsBlob": true,
        "baseHrefApplied": false,
        "relativeFetch": {
          "ok": false,
          "errorName": "TypeError"
        },
        "absoluteFetch": {
          "ok": true,
          "status": 200,
          "text": "ABSOLUTE_BLOB_FETCH_OK"
        },
        "referrerMatchesCreator": true
      },
      "htmlResult": {
        "urlScheme": "blob",
        "originMatchesCreator": true,
        "baseUriIsBlob": true,
        "baseHrefApplied": false,
        "relativeFetch": {
          "ok": false,
          "errorName": "TypeError"
        },
        "absoluteFetch": {
          "ok": true,
          "status": 200,
          "text": "ABSOLUTE_BLOB_FETCH_OK"
        },
        "referrerMatchesCreator": true,
        "openerPresent": false,
        "openerCanReadSameOrigin": null,
        "windowName": "",
        "history": {
          "supported": true,
          "lengthIncreased": true,
          "pushStateError": null,
          "originPreserved": true,
          "fragmentApplied": true
        }
      }
    },
    "emptyMime": {
      "target": "self",
      "samePage": true,
      "hrefScheme": "blob",
      "snapshot": {
        "urlScheme": "blob",
        "originMatchesLoopback": true,
        "contentType": "text/plain",
        "characterSet": "Big5",
        "baseUriKind": "blob",
        "baseHrefPath": null,
        "referrerMatchesFixture": true,
        "name": "",
        "openerPresent": false,
        "openerReadableSameOrigin": null,
        "title": "",
        "imageViewerTitleHasDimensions": null,
        "textPlain": null,
        "textPlainIsHtmlSource": true,
        "htmlUnicodeTextPresent": false,
        "image": null
      },
      "coreResult": null,
      "htmlResult": null
    },
    "octetStream": {
      "target": "self",
      "downloaded": true,
      "suggestedFilenamePresent": true,
      "completed": true
    },
    "plainUtf8Charset": {
      "target": "self",
      "samePage": true,
      "hrefScheme": "blob",
      "snapshot": {
        "urlScheme": "blob",
        "originMatchesLoopback": true,
        "contentType": "text/plain",
        "characterSet": "UTF-8",
        "baseUriKind": "blob",
        "baseHrefPath": null,
        "referrerMatchesFixture": true,
        "name": "",
        "openerPresent": false,
        "openerReadableSameOrigin": null,
        "title": "",
        "imageViewerTitleHasDimensions": null,
        "textPlain": "Blob plain text café 雪",
        "textPlainIsHtmlSource": false,
        "htmlUnicodeTextPresent": null,
        "image": null
      },
      "coreResult": null,
      "htmlResult": null
    }
  },
  "namedReuse": {
    "first": {
      "urlScheme": "blob",
      "originMatchesLoopback": true,
      "contentType": "text/html",
      "characterSet": "UTF-8",
      "baseUriKind": "blob",
      "baseHrefPath": null,
      "referrerMatchesFixture": true,
      "name": "blob-navigation-named",
      "openerPresent": true,
      "openerReadableSameOrigin": true,
      "title": "Blob child",
      "imageViewerTitleHasDimensions": null,
      "textPlain": null,
      "textPlainIsHtmlSource": null,
      "htmlUnicodeTextPresent": true,
      "image": null
    },
    "firstHtmlResult": {
      "urlScheme": "blob",
      "originMatchesCreator": true,
      "baseUriIsBlob": true,
      "baseHrefApplied": false,
      "relativeFetch": {
        "ok": false,
        "errorName": "TypeError"
      },
      "absoluteFetch": {
        "ok": true,
        "status": 200,
        "text": "ABSOLUTE_BLOB_FETCH_OK"
      },
      "referrerMatchesCreator": true,
      "openerPresent": true,
      "openerCanReadSameOrigin": true,
      "windowName": "blob-navigation-named",
      "history": {
        "supported": true,
        "lengthIncreased": true,
        "pushStateError": null,
        "originPreserved": true,
        "fragmentApplied": true
      }
    },
    "firstCoreResult": {
      "urlScheme": "blob",
      "originMatchesCreator": true,
      "baseUriIsBlob": true,
      "baseHrefApplied": false,
      "relativeFetch": {
        "ok": false,
        "errorName": "TypeError"
      },
      "absoluteFetch": {
        "ok": true,
        "status": 200,
        "text": "ABSOLUTE_BLOB_FETCH_OK"
      },
      "referrerMatchesCreator": true
    },
    "second": {
      "urlScheme": "blob",
      "originMatchesLoopback": true,
      "contentType": "text/html",
      "characterSet": "UTF-8",
      "baseUriKind": "http",
      "baseHrefPath": "/base/",
      "referrerMatchesFixture": true,
      "name": "blob-navigation-named",
      "openerPresent": true,
      "openerReadableSameOrigin": true,
      "title": "Blob child",
      "imageViewerTitleHasDimensions": null,
      "textPlain": null,
      "textPlainIsHtmlSource": null,
      "htmlUnicodeTextPresent": true,
      "image": null
    },
    "secondCoreResult": {
      "urlScheme": "blob",
      "originMatchesCreator": true,
      "baseUriIsBlob": false,
      "baseHrefApplied": true,
      "relativeFetch": {
        "ok": true,
        "status": 200,
        "text": "BASE_RELATIVE_FETCH_OK"
      },
      "absoluteFetch": {
        "ok": true,
        "status": 200,
        "text": "ABSOLUTE_BLOB_FETCH_OK"
      },
      "referrerMatchesCreator": true
    },
    "secondHtmlResult": {
      "urlScheme": "blob",
      "originMatchesCreator": true,
      "baseUriIsBlob": false,
      "baseHrefApplied": true,
      "relativeFetch": {
        "ok": true,
        "status": 200,
        "text": "BASE_RELATIVE_FETCH_OK"
      },
      "absoluteFetch": {
        "ok": true,
        "status": 200,
        "text": "ABSOLUTE_BLOB_FETCH_OK"
      },
      "referrerMatchesCreator": true,
      "openerPresent": true,
      "openerCanReadSameOrigin": true,
      "windowName": "blob-navigation-named",
      "history": {
        "supported": true,
        "lengthIncreased": false,
        "pushStateError": "SecurityError",
        "originPreserved": true,
        "fragmentApplied": false
      }
    },
    "pageCount": 2,
    "sameWindowName": true
  },
  "revokeReload": {
    "loadedBeforeRevoke": {
      "urlScheme": "blob",
      "originMatchesLoopback": true,
      "contentType": "text/html",
      "characterSet": "UTF-8",
      "baseUriKind": "blob",
      "baseHrefPath": null,
      "referrerMatchesFixture": true,
      "name": "",
      "openerPresent": false,
      "openerReadableSameOrigin": null,
      "title": "Blob child",
      "imageViewerTitleHasDimensions": null,
      "textPlain": null,
      "textPlainIsHtmlSource": null,
      "htmlUnicodeTextPresent": true,
      "image": null
    },
    "fetchAfterRevoke": {
      "ok": false,
      "errorName": "TypeError"
    },
    "reloadError": "net::ERR_FILE_NOT_FOUND",
    "afterReload": {
      "snapshotFailed": true
    }
  }
}''';
