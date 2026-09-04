import { vi } from "vitest";

// Deterministic fake signed URLs. Factories are invoked from vi.mock() blocks
// inside each test file (vi.mock is hoisted per test file).

export function cloudinaryPackageMockFactory() {
  const destroy = vi.fn(async (_publicId: string, _options?: unknown) => ({ result: "ok" }));
  const url = vi.fn((publicId: string, options: { version?: number; transformation?: unknown[] } = {}) => {
    const blurred = Array.isArray(options.transformation) && options.transformation.length > 0;
    return blurred
      ? `https://mock.cloudinary/authenticated/s--BLURSIG--/e_blur:2000,w_400/v${options.version}/${publicId}`
      : `https://mock.cloudinary/authenticated/s--CLEARSIG--/v${options.version}/${publicId}`;
  });
  const private_download_url = vi.fn((publicId: string, format: string) =>
    `https://mock.cloudinary/download/s--DLSIG--/${publicId}.${format}?expires=600`);
  return {
    v2: {
      config: vi.fn(),
      url,
      uploader: { destroy, upload_stream: vi.fn() },
      utils: { private_download_url }
    }
  };
}

export function backendCloudinaryMockFactory() {
  let counter = 0;
  const uploadImageBuffer = vi.fn(async (_buffer: Buffer, options: { folder?: string; public_id?: string }) => {
    counter += 1;
    const publicId = `${options.folder ?? "around"}/${options.public_id ?? `mock-${counter}`}`;
    return { public_id: publicId, version: 5000 + counter, format: "jpg", bytes: 1234 };
  });
  return {
    isCloudinaryConfigured: () => true,
    cloudinaryUrl: (value: string) => value.startsWith("http://") || value.startsWith("https://"),
    uploadImageBuffer
  };
}

// --- Expo push spy --------------------------------------------------------
// Every message handed to the mocked Expo client lands here, in send order,
// so a test can assert WHO was rung and with WHAT (this module is evaluated
// once per test file, so the registry is per file; reset it in beforeEach).

export type SentPush = { to: string; title?: string; body?: string; data?: Record<string, unknown>; _contentAvailable?: boolean; ttl?: number };

export const expoSent: SentPush[] = [];

export function resetExpoSent() {
  expoSent.length = 0;
}

// Tokens listed here make the mocked client answer a ticket error instead of
// "ok" (e.g. DeviceNotRegistered); a token in `expoChunkPoison` makes the
// WHOLE chunk containing it throw, like Expo does for a token of another
// project (PUSH_TOO_MANY_EXPERIENCE_IDS).
export const expoTicketErrors = new Map<string, string>();
export const expoChunkPoison = new Set<string>();

let ticketSeq = 0;

export function expoMockFactory() {
  class MockExpo {
    chunkPushNotifications(messages: unknown[]) {
      return [messages];
    }

    chunkPushNotificationReceiptIds(ids: string[]) {
      return [ids];
    }

    async sendPushNotificationsAsync(messages: SentPush[]) {
      if (messages.some((message) => expoChunkPoison.has(message.to))) {
        throw new Error("PUSH_TOO_MANY_EXPERIENCE_IDS");
      }
      return messages.map((message) => {
        expoSent.push(message);
        ticketSeq += 1;
        const error = expoTicketErrors.get(message.to);
        return error
          ? { status: "error", message: error, details: { error } }
          : { status: "ok", id: `ticket-${ticketSeq}` };
      });
    }

    async getPushNotificationReceiptsAsync(ids: string[]) {
      return Object.fromEntries(ids.map((id) => [id, { status: "ok" }]));
    }

    static isExpoPushToken(token: string) {
      return typeof token === "string" && token.startsWith("ExponentPushToken");
    }
  }
  return { Expo: MockExpo, default: MockExpo };
}
