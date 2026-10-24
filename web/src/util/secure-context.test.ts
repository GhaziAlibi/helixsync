import { describe, expect, it } from "vitest";
import { isInsecureRemoteHttp } from "./secure-context";

describe("isInsecureRemoteHttp", () => {
  it("flags plain HTTP on a real hostname or address", () => {
    expect(isInsecureRemoteHttp("http:", "sync.example.com")).toBe(true);
    expect(isInsecureRemoteHttp("http:", "192.168.1.20")).toBe(true);
    expect(isInsecureRemoteHttp("http:", "[2001:db8::1]")).toBe(true);
  });

  it("does not flag loopback, where browsers still accept Secure cookies", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "[::1]", "::1"]) {
      expect(isInsecureRemoteHttp("http:", host)).toBe(false);
    }
  });

  it("does not flag HTTPS anywhere", () => {
    expect(isInsecureRemoteHttp("https:", "sync.example.com")).toBe(false);
    expect(isInsecureRemoteHttp("https:", "localhost")).toBe(false);
  });

  it("is not fooled by hostnames that merely start with localhost", () => {
    expect(isInsecureRemoteHttp("http:", "localhost.evil.example")).toBe(true);
  });
});
