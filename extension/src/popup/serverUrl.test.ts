import { describe, expect, it } from "vitest";
import { assertSecureServerUrl, InsecureServerUrlError } from "./serverUrl";

describe("[SEC-17] assertSecureServerUrl", () => {
  it("accepts a remote https URL", () => {
    expect(() => assertSecureServerUrl("https://sync.example.com")).not.toThrow();
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])("accepts loopback http:// (%s)", (host) => {
    expect(() => assertSecureServerUrl(`http://${host}:5173`)).not.toThrow();
  });

  it("rejects a remote http:// URL", () => {
    expect(() => assertSecureServerUrl("http://sync.example.com")).toThrow(InsecureServerUrlError);
  });

  it("rejects a remote http:// URL even on a LAN IP", () => {
    expect(() => assertSecureServerUrl("http://192.168.1.10:5173")).toThrow(InsecureServerUrlError);
  });
});
