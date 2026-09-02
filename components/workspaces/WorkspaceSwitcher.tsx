"use client";

export interface WorkspaceSwitcherItem { id:string; name:string; lifecycleState:string }
export function WorkspaceSwitcher({items,currentId,organizationId}:{items:WorkspaceSwitcherItem[];currentId?:string;organizationId:string}){
  return <label className="flex min-w-0 items-center gap-2 text-sm font-semibold text-navy">Workspace<select aria-label="Switch Workspace" value={currentId??""} onChange={event=>{if(event.target.value)window.location.assign(`/workspaces/${event.target.value}?organizationId=${encodeURIComponent(organizationId)}`)}} className="min-w-0 max-w-64 rounded-button border border-softborder bg-white px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"><option value="">Select</option>{items.map(item=><option key={item.id} value={item.id}>{item.name}{item.lifecycleState!=="active"?` (${item.lifecycleState})`:""}</option>)}</select></label>;
}
