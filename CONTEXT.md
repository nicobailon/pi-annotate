# Pi Annotate

Pi Annotate lets an agent receive visual annotations made by a human in a browser.

## Language

**Pi Session Host**:
The machine where the active Pi agent session is running and where annotation results must be delivered.
_Avoid_: Remote, server, desktop

**Browser Host**:
The machine where the user operates the browser used to make annotations.
_Avoid_: Local, client, laptop

**Same-Host Annotation**:
An annotation flow where the browser and the active Pi agent session are on the same machine.
_Avoid_: Local annotation, default annotation

**Remote Annotation**:
An annotation flow where the Browser Host and Pi Session Host are different machines owned by the same user. With no URL, Remote Annotation uses the Browser Host's current tab. With a URL, the URL is interpreted from the Pi Session Host perspective; Browser Host-local page URLs are not a remote-path design target.
_Avoid_: Collaboration, cloud relay, screen sharing

**Browser Host Alias**:
The configured host name used from the Pi Session Host to identify which Browser Host should receive an annotation request.
_Avoid_: Device name, peer name, target

**Annotated Page Host**:
The machine where the page being annotated is served.
_Avoid_: App host, dev server host, website host

**Browser Host Ready**:
A Browser Host state where it can receive an annotation request without additional user action. Remote Annotation verifies this state but does not try to create it.
_Avoid_: Awake, connected, online

**Annotation Message Tunnel**:
A temporary private path that carries annotation requests and results between a Pi Session Host and a Browser Host.
_Avoid_: Relay, sync channel, collaboration channel

**Page Access Tunnel**:
A temporary private path that lets the Browser Host load a page served only from the Pi Session Host. Remote Annotation creates this only for supported Loopback Page URLs; all other page URLs are passed to the Browser Host unchanged.
_Avoid_: Public URL, deployment, sharing link

**Loopback Page URL**:
A URL whose host names only the current machine, such as `localhost`, `127.0.0.1`, or `[::1]`. In Remote Annotation, this always refers to the Pi Session Host; Browser Host-local pages are reached by omitting the URL and annotating the Browser Host's current tab. Remote page-access tunnels currently support `localhost` and IPv4 loopback; IPv6 loopback URLs such as `[::1]` are rejected to avoid ambiguous SSH tunnel bind/target behavior.
_Avoid_: Browser-local URL, local URL
