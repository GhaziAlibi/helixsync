import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/context";
import ProtectedRoute from "./components/ProtectedRoute";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Recover from "./pages/Recover";
import ResetWithDevices from "./pages/ResetWithDevices";
import Dashboard from "./pages/Dashboard";
import Devices from "./pages/Devices";
import Rulesets from "./pages/Rulesets";
import RestorePoints from "./pages/RestorePoints";
import Backups from "./pages/Backups";
import Sync from "./pages/Sync";
import Vault from "./pages/Vault";
import Security from "./pages/Security";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/recover" element={<Recover />} />
          <Route path="/reset" element={<ResetWithDevices />} />
          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/vault" element={<Vault />} />
            <Route path="/devices" element={<Devices />} />
            <Route path="/sync" element={<Sync />} />
            <Route path="/rulesets" element={<Rulesets />} />
            <Route path="/restore-points" element={<RestorePoints />} />
            <Route path="/backups" element={<Backups />} />
            <Route path="/security" element={<Security />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
