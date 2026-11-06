import { Link, NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth/context";
import LanguageSelect from "./LanguageSelect";

const navItems = [
  { to: "/", key: "nav.dashboard", end: true },
  { to: "/devices", key: "nav.devices" },
  { to: "/sync", key: "nav.sync" },
  { to: "/restore-points", key: "nav.restorePoints" },
  { to: "/security", key: "nav.security" },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 border-e border-slate-200 bg-white p-4 flex flex-col">
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
              {t(item.key)}
            </NavLink>
          ))}
        </nav>
        <LanguageSelect className="mb-3" />
        <div className="text-xs text-slate-500 mb-2 truncate">{user?.email}</div>
        <button
          onClick={() => logout()}
          className="text-sm text-start px-3 py-2 rounded text-slate-700 hover:bg-slate-100"
        >
          {t("layout.logOut")}
        </button>
      </aside>
      <main className="flex-1 p-8">
        {user?.recoveryCodeConfirmed === false && (
          <div role="alert" className="mb-6 text-sm text-amber-900 bg-amber-50 border border-amber-300 rounded px-4 py-3">
            {t("layout.recoveryBanner")}{" "}
            <Link to="/security" className="font-medium underline">
              {t("layout.recoveryBannerLink")}
            </Link>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
