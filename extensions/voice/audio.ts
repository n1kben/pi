import {
  listInputDevices,
  permissionStatus,
  Recorder,
  type InputDevice,
  type Permission,
} from "@handy-computer/recorder";
import type { MicrophoneSetting } from "./settings.ts";

/** 16 kHz mono: what every speech-to-text API expects, so no resampling is needed. */
export const SAMPLE_RATE = 16_000;
const FRAMES_PER_CHUNK = 480;

export type CapturedAudio = {
  pcm: Float32Array;
  interruption?: Error;
  droppedFrames?: number;
};
export type Capture = { stop(): Promise<CapturedAudio> };

export type { InputDevice, Permission };

/** A synchronous read that never prompts. */
export function microphonePermission(): Permission {
  return permissionStatus();
}

/** Input devices to offer, without PulseAudio monitors of outputs. */
export async function listMicrophones(): Promise<InputDevice[]> {
  return (await listInputDevices()).filter((device) => !device.isMonitor);
}

export function findMicrophone(
  devices: readonly InputDevice[],
  selected: { name: string; id: string },
): InputDevice | undefined {
  return devices.find((device) => device.id === selected.id) ?? devices.find((d) => d.name === selected.name);
}

function interruption(recording: { endReason: { kind: string; error?: Error; message?: string } }): Error | undefined {
  if (recording.endReason.kind === "recorderFailed") {
    return (recording.endReason.error as Error | undefined) ?? new Error("The microphone failed");
  }
  if (recording.endReason.kind === "sinkPanicked") {
    return new Error(recording.endReason.message ?? "The microphone stopped");
  }
  return undefined;
}

/** Opens the microphone and starts recording toward `onChunk`. */
export async function openMicrophone(
  microphone: MicrophoneSetting,
  onChunk: (samples: Float32Array) => void,
  onFailure: (error: Error) => void,
): Promise<Capture> {
  let deviceId: string | undefined;
  if (microphone.type === "device") {
    const devices = (await listInputDevices()).filter((device) => !device.isMonitor);
    const device = findMicrophone(devices, microphone);
    if (!device) {
      const available = devices.map((d) => `"${d.name}"`).join(", ") || "none";
      throw new Error(
        `Microphone "${microphone.name}" is unavailable, so voice.json lists a stale device. Available: ${available}. Set "microphone": { "type": "system-default" } or another device's id.`,
      );
    }
    deviceId = device.id;
  }

  const recorder = await Recorder.open({
    device: deviceId,
    sampleRate: SAMPLE_RATE,
    channels: "mono",
    framesPerChunk: FRAMES_PER_CHUNK,
    onChunk: ({ samples }) => onChunk(samples),
    onFailure: (error) => onFailure(error),
  });
  try {
    recorder.start();
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }

  return {
    async stop() {
      try {
        const recording = await recorder.stop();
        return {
          pcm: recording.samples,
          interruption: interruption(recording),
          droppedFrames: recording.droppedFrames,
        };
      } finally {
        // The audio is already in hand; a close that times out only means the
        // platform holds the device until Pi exits.
        await recorder.close().catch(() => undefined);
      }
    },
  };
}

export function describeCaptureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "PermissionDenied") {
    return `Microphone access was denied. ${process.platform === "darwin" ? "Allow your terminal app in System Settings → Privacy & Security → Microphone." : "Grant microphone access to your terminal and try again."}`;
  }
  return `Microphone capture failed: ${message}`;
}
