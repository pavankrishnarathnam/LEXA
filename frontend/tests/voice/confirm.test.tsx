import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ConfirmProvider, useConfirm } from "@/components/voice/confirm-provider";
import { VoiceContext, type VoiceCtx } from "@/components/voice/voice-provider";
import { SERVER_SNAPSHOT } from "@/lib/voice/runtime";

afterEach(cleanup);

/** A stand-in for the real voice provider: like the real one, it re-renders every time LEXA says something and hands
 *  out a brand-new announce() each time. Reading a question aloud must not trigger itself in a loop. */
function FakeVoice({ children, spoken }: { children: React.ReactNode; spoken: string[] }) {
  const [, setTick] = useState(0);
  const value = {
    snap: { ...SERVER_SNAPSHOT, active: true },
    announce: (t: string) => {
      if (spoken.length >= 5) throw new Error("announce() is looping: the dialog reads itself aloud over and over"); // fail fast, never hang
      spoken.push(t);
      setTick((x) => x + 1);
    },
    setHelpOpen: () => undefined,
  } as unknown as VoiceCtx;
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

function Delete({ onResult }: { onResult: (ok: boolean) => void }) {
  const { confirm } = useConfirm();
  return <button onClick={() => void confirm({ title: "Delete Weekly review?", description: "It cannot be undone.", destructive: true }).then(onResult)}>Delete</button>;
}

describe("confirmation dialog", () => {
  it("is a real alertdialog, read aloud exactly once, and answered by its yes/no buttons", async () => {
    const spoken: string[] = [];
    const result = vi.fn();
    render(<FakeVoice spoken={spoken}><ConfirmProvider><Delete onResult={result} /></ConfirmProvider></FakeVoice>);
    fireEvent.click(screen.getByText("Delete"));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete Weekly review?");
    expect(spoken).toEqual(["Delete Weekly review?. It cannot be undone. Say yes or no."]);

    const yes = dialog.querySelector<HTMLElement>('[data-voice-confirm="yes"]')!;
    const no = dialog.querySelector<HTMLElement>('[data-voice-confirm="no"]')!;
    expect(yes.textContent).toBe("Confirm");
    expect(no.textContent).toBe("Cancel");
    await act(async () => { fireEvent.click(no); });
    expect(result).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByText("Delete"));
    await act(async () => { fireEvent.click((await screen.findByRole("alertdialog")).querySelector('[data-voice-confirm="yes"]')!); });
    expect(result).toHaveBeenLastCalledWith(true);
    expect(spoken).toHaveLength(2); // once per dialog
  });

  it("works without any voice provider", async () => {
    const result = vi.fn();
    render(<ConfirmProvider><Delete onResult={result} /></ConfirmProvider>);
    fireEvent.click(screen.getByText("Delete"));
    await act(async () => { fireEvent.click((await screen.findByRole("alertdialog")).querySelector('[data-voice-confirm="yes"]')!); });
    expect(result).toHaveBeenCalledWith(true);
  });
});
