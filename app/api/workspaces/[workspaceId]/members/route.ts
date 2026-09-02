import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getWorkspaceActor,mapWorkspaceError,requireSameOrigin,workspaceError,workspaceServices } from "@/src/application/services/workspaceHttp";
import { resolveOrganizationMemberByEmail } from "@/src/application/services/memberDirectory";
/**
 * A member is named by email OR by user id, and exactly one must be supplied.
 *
 * Email is what the settings UI sends — asking an owner for a collaborator's
 * internal cuid was the launch-blocking UX defect. `userId` is retained because
 * it is the membership domain's actual key and existing callers use it; the
 * email path resolves to the same thing before any authorization runs.
 */
const schema=z.object({organizationId:z.string().min(1),userId:z.string().min(1).optional(),email:z.string().min(3).max(320).optional(),role:z.enum(["owner","editor","commenter","viewer"])}).refine(data=>(data.userId===undefined)!==(data.email===undefined),{message:"Provide exactly one of email or userId."});
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(request:NextRequest,{params}:{params:Promise<{workspaceId:string}>}){const actorResult=await getWorkspaceActor(request,request.nextUrl.searchParams.get("organizationId")??undefined);if("response" in actorResult)return actorResult.response;try{const result=await workspaceServices().memberships.list(actorResult.actor,(await params).workspaceId,request.nextUrl.searchParams.get("cursor")??undefined,Number(request.nextUrl.searchParams.get("limit")??25));return NextResponse.json(result);}catch(error){return mapWorkspaceError(request,error)}}
export async function POST(request:NextRequest,{params}:{params:Promise<{workspaceId:string}>}){
  const csrf=requireSameOrigin(request);if(csrf)return csrf;
  const parsed=schema.safeParse(await request.json().catch(()=>null));
  if(!parsed.success)return workspaceError(request,"INVALID_INPUT","Invalid membership input.",422);
  const actorResult=await getWorkspaceActor(request,parsed.data.organizationId);
  if("response" in actorResult)return actorResult.response;
  // Resolve the email AFTER the actor is authenticated and bound to the
  // Organization, and scope the lookup to that Organization — otherwise this
  // becomes an unauthenticated "does this email have an account?" probe.
  let userId=parsed.data.userId;
  if(userId===undefined){
    const lookup=await resolveOrganizationMemberByEmail(parsed.data.email as string,actorResult.actor.organizationId);
    if(!lookup.ok)return workspaceError(request,"MEMBER_NOT_FOUND",lookup.message,404);
    userId=lookup.userId;
  }
  try{const membership=await workspaceServices().memberships.add(actorResult.actor,(await params).workspaceId,userId,parsed.data.role);await workspaceServices().audit.record({actorType:"user",actorId:actorResult.actor.userId,organizationId:actorResult.actor.organizationId,action:"workspace.membership.add",resourceType:"workspace_membership",resourceId:membership.id});return NextResponse.json({membership},{status:201});}catch(error){return mapWorkspaceError(request,error)}
}
