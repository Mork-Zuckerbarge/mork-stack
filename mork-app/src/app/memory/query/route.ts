import { GET as activityGet } from "@/app/api/channel/activity/route";

export const dynamic = "force-dynamic";

export async function GET() {
  return activityGet();
}
