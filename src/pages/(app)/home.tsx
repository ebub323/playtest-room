/** /home is the scaffold's post-sign-in route; the app's home is /rooms. */
import { Navigate } from 'react-router-dom'

export default function HomePage() {
  return <Navigate to="/rooms" replace />
}
