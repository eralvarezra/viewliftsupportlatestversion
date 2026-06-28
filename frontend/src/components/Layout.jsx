import Header from './Header'
import { useCover } from '../context/CoverContext'

export default function Layout({ children }) {
  const { coverAgent } = useCover()
  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 transition-colors">
      <Header />
      {coverAgent && (
        <div className="bg-orange-500 text-white text-sm font-semibold text-center py-1.5 px-4">
          Respondiendo como: {coverAgent.username} ({coverAgent.email})
        </div>
      )}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  )
}
