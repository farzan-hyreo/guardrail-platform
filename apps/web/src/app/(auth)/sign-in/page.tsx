"use client";

import { signIn } from "@guardrail/auth/client";
import { Button } from "@guardrail/ui/button";
import { Input } from "@guardrail/ui/input";
import { useState } from "react";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setError(null);
    const result = await signIn.email({ email, password, callbackURL: "/projects" });
    if (result.error) setError(result.error.message ?? "That did not work. Check your details.");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Input
        placeholder="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button onClick={handleSignIn}>Sign in</Button>
    </main>
  );
}
