/**
 * Safely set inner HTML of an element using DOMParser (avoids direct innerHTML assignment).
 */
export function safeSetHTML(el, html) {
  el.replaceChildren(...new DOMParser().parseFromString(html, 'text/html').body.childNodes);
}
