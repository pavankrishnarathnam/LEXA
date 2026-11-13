import { Suspense } from "react";
import { AuthForm } from "@/components/layout/auth-form";

export const metadata = { title: "Create account" };
export default function Page() {
  return <Suspense><AuthForm mode="register" /></Suspense>;
}
