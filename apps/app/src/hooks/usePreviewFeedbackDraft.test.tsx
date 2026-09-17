// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadedPromptAttachment } from "@bb/server-contract";
import { usePromptDraftStorage } from "./usePromptDraftStorage";
import {
  addPreviewFeedbackToDraft,
  usePreviewFeedbackDraft,
} from "./usePreviewFeedbackDraft";

const mock = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("@/hooks/mutations/project-mutations", () => ({
  useUploadPromptAttachment: () => ({ mutateAsync: mock.upload }),
}));
afterEach(() => {
  cleanup();
  mock.upload.mockReset();
});
const feedback = {
  url: "http://localhost/",
  title: "Preview",
  screenshot: "aW1hZ2U=",
  element: null,
  console: [],
  network: [],
};
const attachment: UploadedPromptAttachment = {
  type: "localImage",
  path: "/attachments/preview.jpg",
  name: "arc-preview.jpg",
  mimeType: "image/jpeg",
  sizeBytes: 5,
};

describe("preview feedback draft", () => {
  it("uploads a real attachment and preserves typing while its upload is pending", async () => {
    let finish: (value: UploadedPromptAttachment) => void = () => {
      throw new Error("Upload did not start");
    };
    mock.upload.mockImplementation(
      () =>
        new Promise<UploadedPromptAttachment>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => {
      const draft = usePromptDraftStorage({
        kind: "thread",
        projectId: "feedback-project",
        threadId: "feedback-thread",
      });
      usePreviewFeedbackDraft({
        projectId: "feedback-project",
        threadId: "feedback-thread",
        append: (text, attachments) => draft.addQuote(text, attachments),
      });
      return draft;
    });
    act(() => result.current.setTextAndMentions("Keep my draft", []));
    const pending = addPreviewFeedbackToDraft("feedback-thread", feedback);
    act(() =>
      result.current.setTextAndMentions("Keep my draft and new typing", []),
    );
    await act(async () => {
      finish(attachment);
      await pending;
    });
    expect(result.current.text).toContain("Keep my draft and new typing");
    expect(result.current.text).toContain("Preview feedback: Preview");
    expect(result.current.attachments).toEqual([attachment]);
    expect(mock.upload.mock.calls[0]?.[0].file).toBeInstanceOf(File);
    expect(
      JSON.parse(window.localStorage.getItem(result.current.storageKey)!),
    ).toMatchObject({ attachments: [attachment] });
  });
  it("does not attach to another conversation after navigation during upload", async () => {
    let finish: (value: UploadedPromptAttachment) => void = () => {
      throw new Error("Not uploading");
    };
    mock.upload.mockImplementation(
      () =>
        new Promise<UploadedPromptAttachment>((resolve) => {
          finish = resolve;
        }),
    );
    const append = vi.fn();
    const { rerender } = renderHook(
      ({ threadId }) =>
        usePreviewFeedbackDraft({ threadId, projectId: "project", append }),
      { initialProps: { threadId: "original" } },
    );
    const pending = addPreviewFeedbackToDraft("original", feedback);
    rerender({ threadId: "replacement" });
    finish(attachment);
    await expect(pending).rejects.toThrow("conversation changed");
    expect(append).not.toHaveBeenCalled();
  });
  it("rejects feedback during a suspended conversation transition before the old effect is cleaned up", async () => {
    let finish: (value: UploadedPromptAttachment) => void = () => {
      throw new Error("Not uploading");
    };
    mock.upload.mockImplementation(
      () =>
        new Promise<UploadedPromptAttachment>((resolve) => {
          finish = resolve;
        }),
    );
    const appendOriginal = vi.fn();
    const appendReplacement = vi.fn();
    const suspended = new Promise<void>(() => {});
    const { rerender } = renderHook(
      ({ threadId, suspend }) => {
        usePreviewFeedbackDraft({
          threadId,
          projectId: "project",
          append: threadId === "original" ? appendOriginal : appendReplacement,
        });
        if (suspend) throw suspended;
      },
      {
        initialProps: { threadId: "original", suspend: false },
        wrapper: ({ children }) => (
          <Suspense fallback={null}>{children}</Suspense>
        ),
      },
    );
    const pending = addPreviewFeedbackToDraft("original", feedback);
    rerender({ threadId: "replacement", suspend: true });
    finish(attachment);
    await expect(pending).rejects.toThrow("conversation changed");
    expect(appendOriginal).not.toHaveBeenCalled();
    expect(appendReplacement).not.toHaveBeenCalled();
  });
});
