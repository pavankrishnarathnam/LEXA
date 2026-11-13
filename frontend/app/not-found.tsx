import Link from "next/link";
export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center p-6 text-center">
      <div><p className="text-sm text-subtle">404</p><h1 className="mt-1 text-xl font-semibold">This page doesn’t exist.</h1>
        <Link href="/" className="mt-4 inline-block text-sm text-accent hover:underline">Back to Command Center</Link></div>
    </div>
  );
}
