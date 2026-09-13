import type { VercelRequest, VercelResponse } from "@vercel/node";

import { sendVercelResponse, toRequest } from "../_lib/http.ts";
import { handleRoomRequest, productionDependencies } from "../_lib/room-api.ts";

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  await sendVercelResponse(response, await handleRoomRequest(toRequest(request), productionDependencies()));
}
