import { Chat } from "@/components/assistant/chat";
export const metadata = { title: "Assistant" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Chat conversationId={id} />;
}
