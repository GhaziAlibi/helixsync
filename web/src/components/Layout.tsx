import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/context";

const navItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/devices", label: "Devices" },
  { to: "/sync", label: "Synchronization" },
  { to: "/security", label: "Security" },
];

export default function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 border-r border-slate-200 bg-white p-4 flex flex-col">
        <div className="text-lg font-semibold mb-6">HelixSync</div>
        <nav className="flex flex-col gap-1 flex-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded px-3 py-2 text-sm font-medium ${
                  isActive ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="text-xs text-slate-500 mb-2 truncate">{user?.email}</div>
        <button
          onClick={() => logout()}
          className="text-sm text-left px-3 py-2 rounded text-slate-700 hover:bg-slate-100"
        >
          Log out
        </button>
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
