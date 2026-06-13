(function () {
  "use strict";

  var STORAGE_KEY = "robot-talks:reader-position";
  var SAVE_DEBOUNCE_MS = 250;

  function safeGet() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw == null) return null;
      var n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (e) {
      return null;
    }
  }

  function safeSet(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    } catch (e) {
      /* quota exceeded, private mode — ignore */
    }
  }

  function safeRemove() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function hashTargetExists() {
    var hash = window.location.hash;
    if (!hash || hash === "#") return false;
    try {
      return document.getElementById(decodeURIComponent(hash.slice(1))) != null;
    } catch (e) {
      return document.getElementById(hash.slice(1)) != null;
    }
  }

  if ("scrollRestoration" in window.history) {
    try {
      window.history.scrollRestoration = "manual";
    } catch (e) {
      /* ignore */
    }
  }

  // Если пользователь пришёл по якорю (например, из оглавления),
  // не перебиваем его выбор предложением продолжить.
  if (!hashTargetExists()) {
    var saved = safeGet();
    if (saved != null) {
      var resume = window.confirm(
        "Желаете продолжить чтение с предыдущего места?",
      );
      if (resume) {
        window.scrollTo(0, saved);
      } else {
        safeRemove();
      }
    }
  }

  var saveTimer = null;
  function scheduleSave() {
    if (saveTimer != null) return;
    saveTimer = window.setTimeout(function () {
      saveTimer = null;
      var y = Math.round(window.scrollY || window.pageYOffset || 0);
      if (y <= 0) {
        safeRemove();
      } else {
        safeSet(y);
      }
    }, SAVE_DEBOUNCE_MS);
  }

  function flushSave() {
    if (saveTimer != null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    var y = Math.round(window.scrollY || window.pageYOffset || 0);
    if (y <= 0) {
      safeRemove();
    } else {
      safeSet(y);
    }
  }

  window.addEventListener("scroll", scheduleSave, { passive: true });
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushSave();
  });
})();
