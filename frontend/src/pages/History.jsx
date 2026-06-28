import { useState, useEffect, useCallback } from 'react'
import Layout from '../components/Layout'
import client from '../api/client'
import toast from 'react-hot-toast'
import { usePlatform } from '../context/PlatformContext'

export default function History() {
  const [history, setHistory] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [dateFilter, setDateFilter] = useState('all')
  const [hasMore, setHasMore] = useState(true)
  const [skip, setSkip] = useState(0)
  const limit = 20

  // Modal state
  const [selectedEntry, setSelectedEntry] = useState(null)
  const [isModalLoading, setIsModalLoading] = useState(false)
  const [feedbackUpdating, setFeedbackUpdating] = useState(null)

  const { activePlatform } = usePlatform()

  // Fetch history entries
  const fetchHistory = useCallback(async (reset = false) => {
    if (reset) {
      setIsLoading(true)
      setSkip(0)
    } else {
      setIsLoadingMore(true)
    }
    setError(null)

    try {
      const params = {
        skip: reset ? 0 : skip,
        limit,
        platform_id: activePlatform?.id,
      }

      // Add customer name filter
      if (searchQuery.trim()) {
        params.customer_name = searchQuery.trim()
      }

      // Add date filter
      if (dateFilter === '7') {
        params.days = 7
      } else if (dateFilter === '30') {
        params.days = 30
      }

      const response = await client.get('/history', { params })
      const newEntries = response.data

      if (reset) {
        setHistory(newEntries)
        setSkip(limit)
      } else {
        setHistory((prev) => [...prev, ...newEntries])
        setSkip((prev) => prev + limit)
      }

      setHasMore(newEntries.length === limit)
    } catch (err) {
      const message = err.response?.data?.detail || 'Failed to load history. Please try again.'
      setError(message)
      toast.error(message)
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [searchQuery, dateFilter, skip, limit, activePlatform])

  // Reset on platform change
  useEffect(() => {
    if (activePlatform) fetchHistory(true)
  }, [activePlatform?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Initial fetch and refetch on filter change
  useEffect(() => {
    fetchHistory(true)
  }, [dateFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchHistory(true)
    }, 500)

    return () => clearTimeout(timer)
  }, [searchQuery]) // eslint-disable-line react-hooks/exhaustive-deps

  // Handle search input change
  const handleSearchChange = (e) => {
    setSearchQuery(e.target.value)
  }

  // Handle date filter change
  const handleDateFilterChange = (e) => {
    setDateFilter(e.target.value)
  }

  // Handle load more
  const handleLoadMore = () => {
    if (!isLoadingMore && hasMore) {
      fetchHistory(false)
    }
  }

  // Handle entry click - show modal with details
  const handleEntryClick = async (entry) => {
    setSelectedEntry({ ...entry, isLoading: true })
    setIsModalLoading(true)

    try {
      const response = await client.get(`/history/${entry.id}`, { params: { platform_id: activePlatform?.id } })
      setSelectedEntry(response.data)
    } catch (err) {
      const message = err.response?.data?.detail || 'Failed to load entry details.'
      toast.error(message)
      setSelectedEntry(null)
    } finally {
      setIsModalLoading(false)
    }
  }

  // Handle feedback update
  const handleFeedback = async (entryId, feedback) => {
    setFeedbackUpdating(entryId)

    try {
      await client.patch(`/history/${entryId}/feedback`, { feedback }, { params: { platform_id: activePlatform?.id } })

      // Update the entry in the list
      setHistory((prev) =>
        prev.map((item) =>
          item.id === entryId ? { ...item, feedback } : item
        )
      )

      // Update the selected entry if it's the one being updated
      if (selectedEntry && selectedEntry.id === entryId) {
        setSelectedEntry((prev) => ({ ...prev, feedback }))
      }

      toast.success('Feedback updated successfully')
    } catch (err) {
      const message = err.response?.data?.detail || 'Failed to update feedback.'
      toast.error(message)
    } finally {
      setFeedbackUpdating(null)
    }
  }

  // Close modal
  const handleCloseModal = () => {
    setSelectedEntry(null)
  }

  // Format date for display
  const formatDate = (dateString) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  const formatDateTime = (dateString) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // Get feedback button classes
  const getFeedbackButtonClass = (entry, type) => {
    const isActive = entry.feedback === type
    const baseClass = 'px-3 py-1 text-xs font-medium rounded-full transition-colors '

    if (type === 'useful') {
      return isActive
        ? baseClass + 'bg-green-100 text-green-800 ring-1 ring-green-600'
        : baseClass + 'bg-gray-100 text-gray-600 hover:bg-green-50 hover:text-green-700'
    } else {
      return isActive
        ? baseClass + 'bg-red-100 text-red-800 ring-1 ring-red-600'
        : baseClass + 'bg-gray-100 text-gray-600 hover:bg-red-50 hover:text-red-700'
    }
  }

  return (
    <Layout>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-800 dark:text-white">Response History</h2>
        <p className="text-gray-600 mt-1">
          View and manage your previously generated responses
        </p>
      </div>

      {/* Filters Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4 mb-6">
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Search Input */}
          <div className="flex-1">
            <label htmlFor="search" className="sr-only">
              Search by customer name
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <svg
                  className="h-5 w-5 text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
              </div>
              <input
                id="search"
                type="text"
                value={searchQuery}
                onChange={handleSearchChange}
                placeholder="Search by customer name..."
                className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md leading-5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              />
            </div>
          </div>

          {/* Date Filter */}
          <div className="sm:w-48">
            <label htmlFor="date-filter" className="sr-only">
              Filter by date
            </label>
            <select
              id="date-filter"
              value={dateFilter}
              onChange={handleDateFilterChange}
              className="block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md leading-5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            >
              <option value="all">All time</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
            </select>
          </div>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <div className="flex items-center">
            <svg
              className="w-5 h-5 text-red-500 mr-2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <span className="text-red-700">{error}</span>
            <button
              onClick={() => fetchHistory(true)}
              className="ml-4 text-sm text-red-600 hover:text-red-800 underline"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-12">
          <div className="flex flex-col items-center justify-center">
            <svg
              className="animate-spin h-10 w-10 text-blue-600 mb-4"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              ></circle>
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
            <p className="text-gray-500">Loading history...</p>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && history.length === 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-12">
          <div className="flex flex-col items-center justify-center text-center">
            <svg
              className="w-16 h-16 text-gray-300 mb-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              No history found
            </h3>
            <p className="text-gray-500">
              {searchQuery || dateFilter !== 'all'
                ? 'Try adjusting your search or filter criteria'
                : 'Generated responses will appear here'}
            </p>
          </div>
        </div>
      )}

      {/* History List */}
      {!isLoading && !error && history.length > 0 && (
        <div className="space-y-4">
          {history.map((entry) => (
            <div
              key={entry.id}
              onClick={() => handleEntryClick(entry)}
              className="bg-white dark:bg-gray-800 rounded-lg shadow-md p-4 hover:shadow-lg dark:hover:bg-gray-750 transition-shadow cursor-pointer"
            >
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                {/* Main Info */}
                <div className="flex-1 min-w-0">
                  {/* Customer Name and Date */}
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-lg font-semibold text-gray-900 truncate">
                      {entry.customer_name || 'Unknown Customer'}
                    </h3>
                    <span className="text-sm text-gray-500 ml-2 flex-shrink-0">
                      {formatDate(entry.created_at)}
                    </span>
                  </div>

                  {/* Problem Summary */}
                  {entry.problem_summary && (
                    <p className="text-sm text-gray-600 mb-2 line-clamp-2">
                      <span className="font-medium">Problem: </span>
                      {entry.problem_summary}
                    </p>
                  )}

                  {/* Response Preview */}
                  <p className="text-sm text-gray-500 line-clamp-2">
                    {entry.response_preview}
                  </p>
                </div>

                {/* Feedback Buttons */}
                <div className="flex items-center gap-2 flex-shrink-0 sm:ml-4">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleFeedback(entry.id, 'useful')
                    }}
                    disabled={feedbackUpdating === entry.id}
                    className={getFeedbackButtonClass(entry, 'useful')}
                  >
                    <span className="flex items-center">
                      <svg
                        className="w-3 h-3 mr-1"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"
                        />
                      </svg>
                      Useful
                    </span>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleFeedback(entry.id, 'not_useful')
                    }}
                    disabled={feedbackUpdating === entry.id}
                    className={getFeedbackButtonClass(entry, 'not_useful')}
                  >
                    <span className="flex items-center">
                      <svg
                        className="w-3 h-3 mr-1"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5"
                        />
                      </svg>
                      Not useful
                    </span>
                  </button>
                </div>
              </div>
            </div>
          ))}

          {/* Load More Button */}
          {hasMore && (
            <div className="flex justify-center pt-4">
              <button
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="px-6 py-2 bg-white text-gray-700 font-medium rounded-md border border-gray-300 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isLoadingMore ? (
                  <span className="flex items-center">
                    <svg
                      className="animate-spin -ml-1 mr-2 h-4 w-4 text-gray-600"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    Loading...
                  </span>
                ) : (
                  'Load More'
                )}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Detail Modal */}
      {selectedEntry && (
        <div
          className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50 p-4"
          onClick={handleCloseModal}
        >
          <div
            className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between flex-shrink-0">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  {selectedEntry.customer_name || 'Unknown Customer'}
                </h3>
                <p className="text-sm text-gray-500">
                  {formatDateTime(selectedEntry.created_at)}
                </p>
              </div>
              <button
                onClick={handleCloseModal}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            {/* Modal Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {isModalLoading ? (
                <div className="flex items-center justify-center py-12">
                  <svg
                    className="animate-spin h-8 w-8 text-blue-600"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Customer Message */}
                  <div>
                    <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
                      Original Customer Message
                    </h4>
                    <div className="bg-gray-50 dark:bg-gray-700 rounded-md p-4">
                      <p className="text-gray-800 whitespace-pre-wrap">
                        {selectedEntry.customer_message}
                      </p>
                    </div>
                  </div>

                  {/* Parsed Data */}
                  {selectedEntry.parsed_data && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
                        Extracted Information
                      </h4>
                      <div className="bg-gray-50 dark:bg-gray-700 rounded-md p-4">
                        <div className="grid grid-cols-2 gap-4">
                          {selectedEntry.parsed_data.customer_name && (
                            <div>
                              <span className="text-xs font-medium text-gray-500">
                                Customer Name
                              </span>
                              <p className="text-sm text-gray-900">
                                {selectedEntry.parsed_data.customer_name}
                              </p>
                            </div>
                          )}
                          {selectedEntry.parsed_data.email && (
                            <div>
                              <span className="text-xs font-medium text-gray-500">
                                Email
                              </span>
                              <p className="text-sm text-gray-900">
                                {selectedEntry.parsed_data.email}
                              </p>
                            </div>
                          )}
                          {selectedEntry.parsed_data.device && (
                            <div>
                              <span className="text-xs font-medium text-gray-500">
                                Device
                              </span>
                              <p className="text-sm text-gray-900">
                                {selectedEntry.parsed_data.device}
                              </p>
                            </div>
                          )}
                          {selectedEntry.parsed_data.serial_number && (
                            <div>
                              <span className="text-xs font-medium text-gray-500">
                                Serial Number
                              </span>
                              <p className="text-sm text-gray-900">
                                {selectedEntry.parsed_data.serial_number}
                              </p>
                            </div>
                          )}
                        </div>
                        {selectedEntry.parsed_data.problem_summary && (
                          <div className="mt-4">
                            <span className="text-xs font-medium text-gray-500">
                              Problem Summary
                            </span>
                            <p className="text-sm text-gray-900 mt-1">
                              {selectedEntry.parsed_data.problem_summary}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Generated Response */}
                  <div>
                    <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
                      Generated Response
                    </h4>
                    <div className="bg-blue-50 dark:bg-blue-900/20 rounded-md p-4 border border-blue-100 dark:border-blue-800">
                      <p className="text-gray-800 whitespace-pre-wrap">
                        {selectedEntry.generated_response}
                      </p>
                    </div>
                  </div>

                  {/* Feedback Section */}
                  <div>
                    <h4 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-2">
                      Your Feedback
                    </h4>
                    <div className="flex gap-3">
                      <button
                        onClick={() => handleFeedback(selectedEntry.id, 'useful')}
                        disabled={feedbackUpdating === selectedEntry.id}
                        className={getFeedbackButtonClass(selectedEntry, 'useful') + ' px-4 py-2'}
                      >
                        <span className="flex items-center">
                          <svg
                            className="w-4 h-4 mr-1"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"
                            />
                          </svg>
                          Useful
                        </span>
                      </button>
                      <button
                        onClick={() => handleFeedback(selectedEntry.id, 'not_useful')}
                        disabled={feedbackUpdating === selectedEntry.id}
                        className={getFeedbackButtonClass(selectedEntry, 'not_useful') + ' px-4 py-2'}
                      >
                        <span className="flex items-center">
                          <svg
                            className="w-4 h-4 mr-1"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5"
                            />
                          </svg>
                          Not useful
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end flex-shrink-0">
              <button
                onClick={handleCloseModal}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}
