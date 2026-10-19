import * as raster from './document_live_assets_fixture.mjs';
export const svgSource =
  '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" viewBox="0 0 2 2"><path d="M0 0H1V1H0Z" fill="red"/><path d="M1 0H2V1H1Z" fill="lime"/><path d="M0 1H1V2H0Z" fill="blue"/><path d="M1 1H2V2H1Z" fill="white"/></svg>';
export const fixture = {
  ...raster,
  assetHTML: raster.assetHTML.replaceAll('/photo.png', '/photo.svg'),
  startupAssetHTML: raster.startupAssetHTML.replaceAll('/photo.png', '/photo.svg'),
  assetPng: Buffer.from(svgSource).toString('base64'),
};
