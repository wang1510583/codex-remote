(function () {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js?v=20260704-web-push-debug")
      .then(function (registration) { return registration.update(); })
      .catch(function () {});
  });
})();
