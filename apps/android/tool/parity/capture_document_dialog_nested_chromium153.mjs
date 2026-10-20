// Fixed Chromium oracle for two stacked modal dialogs.
// test_browser.mjs refuses the user's everyday Chrome/profile.
import {writeFileSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {requireTestBrowserExecutable} from './test_browser.mjs';

const browser=await chromium.launch({
  executablePath:requireTestBrowserExecutable(),headless:true,
});
try {
  if(!browser.version().startsWith('153.'))
    throw new Error(`Expected pinned Chromium 153, got ${browser.version()}`);
  const page=await browser.newPage({viewport:{width:390,height:796}});
  await page.route('**/*',route=>route.abort());
  const html=`<!doctype html><style>
    body { background:white; }
    dialog { background:white; width:160px; height:120px; }
    #first { z-index:9999; } #second { z-index:-1; }
  </style>
  <button id="outside">Outside</button>
  <dialog id="first" closedby="any"><button id="one">One</button></dialog>
  <dialog id="second" closedby="any"><button id="two">Two</button></dialog>
  <script>
    window.clicks={outside:0,one:0,two:0};
    for(const id of Object.keys(clicks))
      document.getElementById(id).addEventListener('click',()=>clicks[id]++);
    first.showModal();second.showModal();
  </script>`;
  await page.setContent(html);
  const snapshot=()=>page.evaluate(()=>({
    modalIds:[...document.querySelectorAll(':modal')].map(x=>x.id),
    activeElement:document.activeElement.id,
    clicks:{...window.clicks},
  }));
  const initial=await snapshot();
  const blockedScriptFocus=await page.evaluate(()=>{
    one.focus();const afterLower=document.activeElement.id;
    outside.focus();const afterOutside=document.activeElement.id;
    return {afterLower,afterOutside};
  });
  const tabFocusSequence=[];
  for(const key of ['Tab','Tab','Shift+Tab','Shift+Tab']) {
    await page.keyboard.press(key);
    tabFocusSequence.push(await page.evaluate(()=>document.activeElement.id));
  }
  const png=await page.screenshot();
  const backdropPixel=await page.evaluate(async base64=>{
    const image=new Image();
    image.src=`data:image/png;base64,${base64}`;
    await image.decode();
    const canvas=document.createElement('canvas');
    canvas.width=image.width;canvas.height=image.height;
    const context=canvas.getContext('2d');context.drawImage(image,0,0);
    return [...context.getImageData(20,200,1,1).data];
  },png.toString('base64'));
  const one=await page.locator('#one').boundingBox();
  await page.mouse.click(one.x+one.width/2,one.y+one.height/2);
  const blockedFirstClick=await snapshot();
  await page.mouse.click(20,200);
  const afterTopBackdrop=await snapshot();
  await page.mouse.click(one.x+one.width/2,one.y+one.height/2);
  const afterFirstClick=await snapshot();
  await page.mouse.click(20,200);
  const afterBothBackdrops=await snapshot();
  const touchContext=await browser.newContext({
    viewport:{width:390,height:796},hasTouch:true,isMobile:true,
  });
  const touchPage=await touchContext.newPage();
  await touchPage.route('**/*',route=>route.abort());
  await touchPage.setContent(html);
  const touchSnapshot=()=>touchPage.evaluate(()=>({
    modalIds:[...document.querySelectorAll(':modal')].map(x=>x.id),
    activeElement:document.activeElement.id,
    clicks:{...window.clicks},
  }));
  const touchOne=await touchPage.locator('#one').boundingBox();
  const touchX=touchOne.x+touchOne.width/2;
  const touchY=touchOne.y+touchOne.height/2;
  const touch={initial:await touchSnapshot()};
  await touchPage.touchscreen.tap(touchX,touchY);
  touch.blockedFirstClick=await touchSnapshot();
  await touchPage.touchscreen.tap(20,200);
  touch.afterTopBackdrop=await touchSnapshot();
  await touchPage.touchscreen.tap(touchX,touchY);
  touch.afterFirstClick=await touchSnapshot();
  await touchPage.touchscreen.tap(20,200);
  touch.afterBothBackdrops=await touchSnapshot();
  await touchContext.close();
  const fixture={
    oracle:'Dedicated Playwright-pinned Chromium Headless Shell; no external requests or daily Chrome profile.',
    browserVersion:browser.version(),viewport:{width:390,height:796},
    backdropPixel,initial,blockedScriptFocus,tabFocusSequence,touch,
    blockedFirstClick,afterTopBackdrop,
    afterFirstClick,afterBothBackdrops,
  };
  const output=new URL('./fixtures/document-dialog-nested-chromium153.json',import.meta.url);
  writeFileSync(output,JSON.stringify(fixture,null,2)+'\n');
  console.log(output.pathname);
} finally {
  await browser.close();
}
