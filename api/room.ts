import type { VercelRequest, VercelResponse } from "@vercel/node";

import { roomActionRequest, sendVercelResponse, toRequest } from "./_lib/http.ts";
import { handleRoomRequest, productionDependencies } from "./_lib/room-api.ts";
import { handleSignalingRequest, productionSignalingDependencies } from "./_lib/signaling-api.ts";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const webRequest = roomActionRequest(toRequest(request));
  const result = new URL(webRequest.url).pathname.endsWith("/signals")
    ? await handleSignalingRequest(webRequest, productionSignalingDependencies())
    : await handleRoomRequest(webRequest, productionDependencies());
  await sendVercelResponse(response, result);
}
