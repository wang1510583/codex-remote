(function () {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js?v=20260815-codex-subdomain")
      .then(function (registration) { return registration.update(); })
      .catch(function () {});
  });
})();
