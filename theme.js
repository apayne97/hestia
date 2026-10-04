// Dark mode toggle, shared by every page. The actual theme
// (document.documentElement.dataset.theme) is set as early as possible by
// a tiny inline <script> in each page's <head> (before the stylesheet
// loads) so there's no light-mode flash on load — this file only wires up
// the visible toggle button and keeps localStorage in sync with clicks.
function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("hestia-theme", theme); } catch (e) { /* private mode, blocked storage, etc */ }
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = theme === "dark" ? "☀" : "☽"; // sun (switch to light) / moon (switch to dark)
}

function initThemeToggle() {
  const btn = document.getElementById("themeToggle");
  if (!btn) return;
  setTheme(currentTheme());
  btn.addEventListener("click", () => setTheme(currentTheme() === "dark" ? "light" : "dark"));
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initThemeToggle);
else initThemeToggle();
