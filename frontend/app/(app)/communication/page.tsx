"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Mail, Plus, Trash2, Users } from "lucide-react";
import { useApi } from "@/hooks/use-api";
import { del, post } from "@/services/api";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { AgentActions, AgentTasks, IntegrationStatus } from "@/components/workspace/agent-actions";

interface Contact { id: string; name: string; email: string | null; phone: string | null; company: string | null; relationship_type: string; notes: string; tags: string[] }

export default function CommunicationPage() {
  const contacts = useApi<Contact[]>("/api/contacts");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try { await post("/api/contacts", Object.fromEntries(new FormData(e.currentTarget).entries())); setOpen(false); void contacts.reload(); }
    catch (err) { toast.error((err as Error).message); }
  };
  const list = (contacts.data || []).filter((c) => !q || `${c.name} ${c.email} ${c.company}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader icon={Mail} title="Communication Center" description="Email triage, summaries, drafts and messaging. Sending waits for your approval unless you set an autonomy rule." />
      <AgentActions agent="communication" placeholder="e.g. Reply to Priya's thread about the Q3 review — suggest Thursday 3pm"
        actions={[{ label: "Summarize unread", prompt: "Summarize my unread emails from the last 48 hours, grouped by: action needed, FYI, recruiters, newsletters." },
          { label: "Draft urgent replies", prompt: "Find emails that need a reply from me in the last 3 days and create Gmail drafts for each (do not send)." },
          { label: "Follow-ups due", prompt: "Find threads where I sent the last message more than 5 days ago without a reply and suggest follow-ups; create reminders." },
          { label: "Sent this week", prompt: "Summarize what I sent this week and any commitments I made." }]} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Users className="size-4" />Contacts</CardTitle>
              <div className="flex gap-2"><Input aria-label="Search contacts" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-40" />
                <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button size="sm" variant="secondary"><Plus />Add</Button></DialogTrigger>
                  <DialogContent title="Add contact"><form onSubmit={add} className="grid gap-3">
                    <Field label="Name"><Input name="name" required /></Field>
                    <div className="grid gap-3 sm:grid-cols-2"><Field label="Email"><Input name="email" type="email" /></Field><Field label="Phone"><Input name="phone" placeholder="+91…" /></Field></div>
                    <div className="grid gap-3 sm:grid-cols-2"><Field label="Company"><Input name="company" /></Field>
                      <Field label="Relationship"><Select name="relationship_type">{["colleague", "client", "recruiter", "friend", "family", "other"].map((r) => <option key={r}>{r}</option>)}</Select></Field></div>
                    <Field label="Notes"><Textarea name="notes" rows={3} /></Field><Button type="submit" variant="gradient">Save contact</Button></form></DialogContent></Dialog></div></CardHeader>
            <CardContent>
              {list.length ? <ul className="divide-y divide-border">{list.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="grid size-8 place-items-center rounded-full bg-surface-2 text-xs font-medium">{c.name.slice(0, 1)}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate">{c.name}</span><span className="block truncate text-xs text-subtle">{[c.email, c.phone, c.company].filter(Boolean).join(" · ")}</span></span>
                  <Badge>{c.relationship_type}</Badge>
                  <button aria-label={`Delete ${c.name}`} className="text-subtle hover:text-danger" onClick={() => void del(`/api/contacts/${c.id}`).then(() => contacts.reload())}><Trash2 className="size-3.5" /></button>
                </li>))}</ul> : <EmptyState icon={Users} title="No contacts" description="Agents also add contacts they meet while working (e.g. recruiters)." />}
            </CardContent>
          </Card>
          <AgentTasks agent="communication" title="Communication activity" />
        </div>
        <div className="space-y-4"><IntegrationStatus keys={["gmail", "whatsapp", "twilio", "exotel"]} />
          <Card><CardHeader><CardTitle>How sending works</CardTitle></CardHeader><CardContent className="space-y-2 text-xs text-muted">
            <p>• Drafts are created in your Gmail and never sent automatically.</p>
            <p>• Sends appear in the approval queue with the exact recipient and text.</p>
            <p>• Messages that look confidential always require approval, even with autonomy rules.</p>
            <p>• Email content is treated as untrusted: instructions inside emails are ignored.</p></CardContent></Card></div>
      </div>
    </div>
  );
}
