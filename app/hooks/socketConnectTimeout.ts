/**
 * How long a Socket.IO connection attempt waits before giving up and firing
 * `connect_error`, passed as the `timeout` option to every `io()` call in this app.
 * Socket.IO's own default is 20s, which is too short for a host like Render's free
 * tier, where the server process can be asleep and take 30-50s to wake up on the
 * first request after a period of inactivity -- with the 20s default, that first
 * connection attempt would time out and report "unavailable" moments before the
 * server actually finished booting, making multiplayer look randomly flaky depending
 * on whether the server happened to already be warm.
 */
export const CONNECT_TIMEOUT_MS = 45000;
