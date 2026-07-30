import { Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { AttachmentSnapshot, PrivatePreviewAttachments } from "#src/attachments.ts";

const previews = [
  { label: "web", url: "https://web.example.private/", port: 3_000 },
  { label: "storybook", url: "https://storybook.example.private/", port: 6_006 },
] as const;

describe("attachment contracts", () => {
  test("round-trips provider SSH metadata and private previews", () => {
    const encoded = {
      ssh: { host: "bounty.example.private", port: 22, user: "bebop" },
      previews,
      updatedAt: "2026-07-26T12:34:56.000Z",
    } as const;
    const snapshot = Schema.decodeUnknownSync(AttachmentSnapshot)(encoded);

    expect(Schema.encodeSync(AttachmentSnapshot)(snapshot)).toEqual(encoded);
  });

  test("accepts an empty replacement snapshot to remove all previews", () => {
    expect(Schema.decodeUnknownSync(PrivatePreviewAttachments)([])).toEqual([]);
  });

  test("rejects duplicate labels, duplicate ports, and unsafe URLs", () => {
    expect(() =>
      Schema.decodeUnknownSync(PrivatePreviewAttachments)([previews[0], { ...previews[1], label: previews[0].label }]),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PrivatePreviewAttachments)([previews[0], { ...previews[1], port: previews[0].port }]),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PrivatePreviewAttachments)([{ ...previews[0], url: "http://web.example.private/" }]),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PrivatePreviewAttachments)([
        { ...previews[0], url: "https://user:password@web.example.private/" },
      ]),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PrivatePreviewAttachments)([
        { ...previews[0], url: "https://web.example.private/#fragment" },
      ]),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PrivatePreviewAttachments)([
        { ...previews[0], url: "https://WEB.example.private:443/" },
      ]),
    ).toThrow();
  });

  test("rejects SSH hosts that could be interpreted as paths or options", () => {
    for (const host of ["foo/bar", "-oProxyCommand=bad", "host\0name"]) {
      expect(() =>
        Schema.decodeUnknownSync(AttachmentSnapshot)({
          ssh: { host, port: 22, user: "bebop" },
          previews: [],
          updatedAt: "2026-07-26T12:34:56.000Z",
        }),
      ).toThrow();
    }
  });
});
