// Webview preload — first-pass fake fullscreen injection at document-start.
// Injects a <script> tag into the main world that replaces the Fullscreen API
// with a CSS-based fake.  If CSP blocks this, the main process re-injects the
// same code via executeJavaScript (which bypasses CSP) at dom-ready.

(function () {
  'use strict';

  const injectedCode = `
(function() {
  if (window.__ppFakeFs) return;
  window.__ppFakeFs = true;
  var fsEl = null;
  var CLS = '__pp_fs';
  var s = document.createElement('style');
  s.textContent =
    '.' + CLS + '{position:fixed!important;top:0!important;left:0!important;' +
    'width:100vw!important;height:100vh!important;z-index:2147483647!important;' +
    'background:#000!important;margin:0!important;padding:0!important;border:none!important}' +
    '.' + CLS + ' video,.' + CLS + ' .html5-video-container,.' + CLS + ' .html5-main-video{' +
    'width:100%!important;height:100%!important;object-fit:contain!important;' +
    'max-width:none!important;max-height:none!important}';
  (document.head||document.documentElement).appendChild(s);
  function notify(){
    document.dispatchEvent(new Event('fullscreenchange'));
    document.dispatchEvent(new Event('webkitfullscreenchange'));
  }
  var fakeReq = function(){
    if(fsEl&&fsEl!==this) fsEl.classList.remove(CLS);
    fsEl=this; this.classList.add(CLS); notify();
    return Promise.resolve();
  };
  Element.prototype.requestFullscreen = fakeReq;
  Element.prototype.webkitRequestFullscreen = fakeReq;
  Element.prototype.webkitRequestFullScreen = fakeReq;
  if(typeof HTMLElement!=='undefined'){
    HTMLElement.prototype.requestFullscreen = fakeReq;
    HTMLElement.prototype.webkitRequestFullscreen = fakeReq;
    HTMLElement.prototype.webkitRequestFullScreen = fakeReq;
  }
  var fakeExit = function(){
    if(fsEl){fsEl.classList.remove(CLS);fsEl=null;}
    notify(); return Promise.resolve();
  };
  Document.prototype.exitFullscreen = fakeExit;
  Document.prototype.webkitExitFullscreen = fakeExit;
  Document.prototype.webkitCancelFullScreen = fakeExit;
  var dp=Document.prototype;
  Object.defineProperty(dp,'fullscreenElement',{get:function(){return fsEl},configurable:true});
  Object.defineProperty(dp,'webkitFullscreenElement',{get:function(){return fsEl},configurable:true});
  Object.defineProperty(dp,'webkitCurrentFullScreenElement',{get:function(){return fsEl},configurable:true});
  Object.defineProperty(dp,'fullscreenEnabled',{get:function(){return true},configurable:true});
  Object.defineProperty(dp,'webkitFullscreenEnabled',{get:function(){return true},configurable:true});
  Object.defineProperty(dp,'fullscreen',{get:function(){return !!fsEl},configurable:true});
  Object.defineProperty(dp,'webkitIsFullScreen',{get:function(){return !!fsEl},configurable:true});
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&fsEl) fakeExit();
  },true);
})();
`;

  const script = document.createElement('script');
  script.textContent = injectedCode;
  (document.head || document.documentElement).prepend(script);
  script.remove();
})();
