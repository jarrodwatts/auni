import type { Metadata } from "next";

import { ChatsPlace } from "@/components/places/chats-place";

export const metadata: Metadata = { title: "Chats" };

export default function ChatsPage() {
  return <ChatsPlace />;
}
