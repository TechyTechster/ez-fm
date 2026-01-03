(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("picker") === "true") {
    document.documentElement.classList.add("picker-mode-early");
  }
})();
