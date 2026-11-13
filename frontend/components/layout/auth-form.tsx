"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { LexaMark } from "@/components/layout/orb";
import { post } from "@/services/api";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setLoading(true);
    setError(null);
    try {
      await post(`/api/auth/${mode}`, Object.fromEntries(f.entries()));
      const next = params.get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-5" aria-describedby={error ? "auth-error" : undefined}>
      <div className="space-y-2">
        <LexaMark className="size-9 lg:hidden" />
        <h1 className="text-2xl font-semibold tracking-tight">{mode === "login" ? "Welcome back" : "Create your LEXA"}</h1>
        <p className="text-sm text-muted">{mode === "login" ? "Sign in to your command center." : "The first account becomes the owner of this instance."}</p>
      </div>
      {mode === "register" && (
        <Field label="Full name" htmlFor="full_name"><Input id="full_name" name="full_name" autoComplete="name" /></Field>
      )}
      <Field label="Email" htmlFor="email"><Input id="email" name="email" type="email" required autoComplete="email" /></Field>
      <Field label="Password" htmlFor="password" hint={mode === "register" ? "At least 10 characters." : undefined}>
        <Input id="password" name="password" type="password" required minLength={mode === "register" ? 10 : 1}
          autoComplete={mode === "login" ? "current-password" : "new-password"} />
      </Field>
      {error && <p id="auth-error" role="alert" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
      <Button type="submit" variant="gradient" className="w-full" size="lg" loading={loading}>
        {mode === "login" ? "Sign in" : "Create account"}
      </Button>
      <p className="text-center text-sm text-muted">
        {mode === "login" ? <>New here? <Link className="text-accent hover:underline" href="/register">Create an account</Link></>
          : <>Already have an account? <Link className="text-accent hover:underline" href="/login">Sign in</Link></>}
      </p>
    </form>
  );
}
