# Field REPORT Pilot Web Fallback

Native iOS distribution is preferred. This static PWA exists only so a field pilot is not blocked by Apple provisioning.

- No server-side customer data storage.
- Photos and site/place memory stay in browser IndexedDB on the device.
- Camera/import works through iOS Safari file capture.
- After first HTTPS load, the service worker caches the app shell for offline reopening.
- Report export creates a self-contained HTML file with embedded images; Safari can Print/Share it as PDF.
- No AI/VLM runtime and no automatic location authority.

Serve over HTTPS for camera/PWA behavior. A local `python3 -m http.server` is suitable only for desktop smoke tests; iPhone production use should use an HTTPS origin.
