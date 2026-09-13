import type { VercelRequest, VercelResponse } from "@vercel/node";

import { sendVercelResponse, toRequest } from "../_lib/http.ts";
import { handleRoomRequest, productionDependencies } from "./room-api.ts";
import { handleSignalingRequest, productionSignalingDependencies } from "./signaling-api.ts";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  const webRequest = toRequest(request);
  const result = new URL(webRequest.url).pathname.endsWith("/signals")
    ? await handleSignalingRequest(webRequest, productionSignalingDependencies())
    : await handleRoomRequest(webRequest, productionDependencies());
  await sendVercelResponse(response, result);
}
