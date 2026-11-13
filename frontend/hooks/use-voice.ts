"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/services/api";

type VoiceState = "idle" | "listening" | "processing" | "speaking";

/**
 * Voice I/O. Speech-to-text prefers the browser's SpeechRecognition (on-device/vendor) and falls back to
 * recording + server transcription (OpenAI) when unavailable. Text-to-speech uses the server voice when
 * configured, otherwise browser speechSynthesis. Microphone access only happens after a user gesture.
 */
export function useVoice(onTranscript: (text: string) => void) {
  const [state, setState] = useState<VoiceState>("idle");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const recRef = useRef<any>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const cbRef = useRef(onTranscript);
  useEffect(() => {
    cbRef.current = onTranscript;
  });

  const stopMeter = () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setLevel(0);
  };

  const meter = (stream: MediaStream) => {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(buf);
      setLevel(buf.reduce((a, b) => a + b, 0) / buf.length / 255);
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  const stopSpeaking = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setState((s) => (s === "speaking" ? "idle" : s));
  }, []);

  const start = useCallback(async () => {
    setError(null);
    stopSpeaking(); // interruption: talking over LEXA stops playback
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      meter(stream);
      const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SR) {
        const rec = new SR();
        rec.lang = navigator.language || "en-US";
        rec.interimResults = true;
        rec.continuous = false;
        let finalText = "";
        rec.onresult = (e: any) => {
          let tmp = "";
          for (let i = e.resultIndex; i < e.results.length; i++) {
            if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
            else tmp += e.results[i][0].transcript;
          }
          setInterim(finalText + tmp);
        };
        rec.onerror = (e: any) => setError(e.error === "not-allowed" ? "Microphone permission denied" : e.error);
        rec.onend = () => {
          stopMeter();
          setInterim("");
          setState("idle");
          if (finalText.trim()) cbRef.current(finalText.trim());
        };
        recRef.current = rec;
        rec.start();
      } else {
        const chunks: Blob[] = [];
        const mr = new MediaRecorder(stream);
        mr.ondataavailable = (e) => chunks.push(e.data);
        mr.onstop = async () => {
          stopMeter();
          setState("processing");
          try {
            const fd = new FormData();
            fd.append("audio", new Blob(chunks, { type: mr.mimeType }), "speech.webm");
            const r = await api<{ text: string }>("/api/voice/transcribe", { method: "POST", body: fd });
            if (r.text.trim()) cbRef.current(r.text.trim());
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setState("idle");
          }
        };
        mediaRef.current = mr;
        mr.start();
      }
      setState("listening");
    } catch (e) {
      stopMeter();
      setError((e as Error).name === "NotAllowedError" ? "Microphone permission denied" : (e as Error).message);
      setState("idle");
    }
  }, [stopSpeaking]);

  const stop = useCallback(() => {
    recRef.current?.stop();
    if (mediaRef.current?.state === "recording") mediaRef.current.stop();
  }, []);

  const speak = useCallback(async (text: string, serverVoice = true) => {
    stopSpeaking();
    const clean = text.replace(/```[\s\S]*?```/g, " code block ").replace(/[#*_`>|-]/g, " ").slice(0, 3500);
    setState("speaking");
    if (serverVoice) {
      try {
        const blob = await api<Blob>("/api/voice/speak", { method: "POST", json: { text: clean } });
        const audio = new Audio(URL.createObjectURL(blob));
        audioRef.current = audio;
        audio.onended = () => setState("idle");
        await audio.play();
        return;
      } catch {
        /* fall back to browser voice */
      }
    }
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(clean);
      u.onend = () => setState("idle");
      window.speechSynthesis.speak(u);
    } else setState("idle");
  }, [stopSpeaking]);

  useEffect(() => () => {
    stopMeter();
    stopSpeaking();
  }, [stopSpeaking]);

  return { state, interim, error, level, start, stop, speak, stopSpeaking };
}
