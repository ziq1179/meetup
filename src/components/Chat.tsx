import { useState, useEffect, useRef } from 'react'

interface ChatMessage {
  message: string
  userName: string
  userId: string
  socketId: string
  timestamp: number
  isOwn?: boolean
}

interface ChatProps {
  socket: any
  roomId: string
  userName: string
  userId: string
  isOpen: boolean
  onToggle: () => void
  onMessageCountChange?: (count: number) => void
}

export default function Chat({ socket, roomId, userName, userId, isOpen, onToggle, onMessageCountChange }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputMessage, setInputMessage] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatContainerRef = useRef<HTMLDivElement>(null)
  const emojiPickerRef = useRef<HTMLDivElement>(null)
  const lastMessageCountRef = useRef(0)

  useEffect(() => {
    if (!socket) {
      console.warn('Chat: Socket not available')
      setIsConnected(false)
      return
    }

    setIsConnected(socket.connected)

    const handleConnect = () => {
      console.log('Chat: Socket connected, socket ID:', socket.id)
      setIsConnected(true)
      
      // Test: Send a system message when connected
      if (messages.length === 0) {
        setMessages([{
          message: 'Chat connected',
          userName: 'System',
          userId: 'system',
          socketId: 'system',
          timestamp: Date.now(),
          isOwn: false
        }])
      }
    }

    const handleDisconnect = () => {
      console.log('Chat: Socket disconnected')
      setIsConnected(false)
    }

    const handleChatMessage = (data: ChatMessage) => {
      console.log('Chat: Received chat message:', data)
      console.log('Chat: Current socket ID:', socket.id)
      console.log('Chat: Message socket ID:', data.socketId)
      console.log('Chat: Is own message?', data.socketId === socket.id)
      
      // Check if we already have this message (avoid duplicates from optimistic update)
      setMessages(prev => {
        // Check if message already exists (by timestamp and socketId)
        const exists = prev.some(msg => 
          msg.socketId === data.socketId && 
          msg.timestamp === data.timestamp &&
          msg.message === data.message
        )
        
        if (exists) {
          console.log('Chat: Message already exists, skipping duplicate')
          return prev
        }
        
        const newMessages = [...prev, {
          ...data,
          isOwn: data.socketId === socket.id
        }]
        
        // Notify parent of message count change
        if (onMessageCountChange) {
          onMessageCountChange(newMessages.length)
        }
        
        return newMessages
      })
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('chat-message', handleChatMessage)
    console.log('Chat: Listening for chat-message events, connected:', socket.connected)

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('chat-message', handleChatMessage)
    }
  }, [socket])

  useEffect(() => {
    // Only scroll chat messages area, not the main page
    if (messagesEndRef.current && chatContainerRef.current) {
      // Use scrollTop instead of scrollIntoView to avoid affecting parent page
      const container = chatContainerRef.current
      container.scrollTop = container.scrollHeight
    }
    
    // Notify parent of message count change
    if (onMessageCountChange && messages.length !== lastMessageCountRef.current) {
      lastMessageCountRef.current = messages.length
      onMessageCountChange(messages.length)
    }
  }, [messages, onMessageCountChange])

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault()
    const messageText = inputMessage.trim()
    
    if (!messageText || !socket) {
      console.warn('Cannot send message: socket not available or message empty')
      return
    }

    if (!socket.connected) {
      console.error('Socket not connected, cannot send message')
      return
    }

    // Ensure we're in the room before sending
    if (!socket.rooms || !socket.rooms.has(roomId)) {
      console.warn('Socket not in room, joining now...')
      socket.emit('join-room', {
        roomId,
        userId,
        userName
      })
      // Wait a bit for room join to complete, then send
      setTimeout(() => {
        sendMessageInternal(messageText)
      }, 100)
      return
    }

    sendMessageInternal(messageText)
  }

  const sendMessageInternal = (messageText: string) => {
    if (!socket || !socket.connected || !messageText) {
      return
    }

    const messageData = {
      roomId,
      message: messageText,
      userName,
      userId,
      timestamp: Date.now()
    }

    console.log('Sending chat message:', messageData)
    console.log('Socket state:', {
      connected: socket.connected,
      id: socket.id,
      disconnected: socket.disconnected,
      rooms: socket.rooms ? Array.from(socket.rooms) : 'unknown'
    })
    
    // Add optimistic UI update - show message immediately
    const tempMessage: ChatMessage = {
      ...messageData,
      socketId: socket.id,
      isOwn: true
    }
    
    // Only add optimistic message if we're connected
    if (socket.connected) {
      setMessages(prev => [...prev, tempMessage])
    }
    // Clear input after sending
    setInputMessage('')
    
    console.log('Chat: Emitting chat-message event with data:', messageData)
    console.log('Chat: Socket connected?', socket.connected)
    console.log('Chat: Socket ID:', socket.id)
    console.log('Chat: Room ID:', roomId)
    
    socket.emit('chat-message', messageData, (response: any) => {
      if (response && response.error) {
        console.error('Chat message error:', response.error)
        // Remove optimistic message on error
        setMessages(prev => prev.filter(msg => 
          !(msg.socketId === tempMessage.socketId && 
            msg.timestamp === tempMessage.timestamp &&
            msg.message === tempMessage.message)
        ))
      } else {
        console.log('Chat message sent successfully, response:', response)
      }
    })
  }

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  // Common emojis for quick access
  const commonEmojis = [
    '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
    '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰',
    '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜',
    '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏',
    '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😖',
    '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡',
    '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '👏',
    '🙌', '👐', '🤲', '🤝', '🙏', '💪', '❤️', '💯',
    '🔥', '⭐', '✨', '🎉', '🎊', '✅', '❌', '⚠️'
  ]

  const insertEmoji = (emoji: string) => {
    setInputMessage(prev => prev + emoji)
    setShowEmojiPicker(false)
  }

  // Close emoji picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
        setShowEmojiPicker(false)
      }
    }

    if (showEmojiPicker) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showEmojiPicker])

  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        className="absolute right-3 bottom-[calc(6rem+env(safe-area-inset-bottom,0px))] z-40 p-4 rounded-full bg-primary-100 hover:bg-primary-200 active:bg-primary-300 text-primary-700 transition-all shadow-md sm:right-4 sm:bottom-24"
        title="Open Chat"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        {messages.length > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
            {messages.length}
          </span>
        )}
      </button>
    )
  }

  return (
    <div 
      className="absolute inset-x-2 bottom-[calc(6rem+env(safe-area-inset-bottom,0px))] h-[45dvh] bg-white backdrop-blur-md border-2 border-primary-200 rounded-lg flex flex-col z-50 shadow-2xl sm:inset-x-auto sm:bottom-24 sm:right-0 sm:w-80 sm:h-96"
      style={{ 
        maxHeight: 'calc(100dvh - 120px)', // Prevent overflow
        overflow: 'hidden' // Contain scrolling within chat panel
      }}
    >
      {/* Chat Header */}
      <div className="flex items-center justify-between p-4 border-b border-primary-200 bg-primary-50">
        <div className="flex items-center gap-2">
          <h3 className="text-primary-700 font-semibold">Chat</h3>
          {!isConnected && (
            <span className="text-xs text-primary-600">Connecting...</span>
          )}
          {isConnected && (
            <div className="w-2 h-2 bg-green-500 rounded-full"></div>
          )}
        </div>
        <button
          onClick={onToggle}
          className="text-gray-600 hover:text-primary-700 transition"
          title="Close Chat"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div ref={chatContainerRef} className="flex-1 overflow-y-auto scroll-container p-4 space-y-3 bg-white">
        {messages.length === 0 ? (
          <div className="text-center text-gray-500 text-sm mt-8">
            No messages yet. Start the conversation!
          </div>
        ) : (
          messages.map((msg, index) => (
            <div
              key={index}
              className={`flex flex-col ${msg.isOwn ? 'items-end' : 'items-start'}`}
            >
              <div className={`max-w-[80%] rounded-lg px-3 py-2 ${
                msg.isOwn
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-100 text-gray-900 border border-gray-200'
              }`}>
                {!msg.isOwn && (
                  <div className="text-xs text-primary-700 font-medium mb-1">{msg.userName}</div>
                )}
                <div className="text-sm">{msg.message}</div>
                <div className={`text-xs mt-1 ${
                  msg.isOwn ? 'text-primary-100' : 'text-gray-500'
                }`}>
                  {formatTime(msg.timestamp)}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={sendMessage} className="p-4 border-t border-primary-200 bg-primary-50 relative">
        <div className="flex gap-2">
          {/* Emoji Picker Button */}
          <div className="relative" ref={emojiPickerRef}>
            <button
              type="button"
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              className="p-2 bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 rounded-lg transition"
              title="Add emoji"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
            
            {/* Emoji Picker */}
            {showEmojiPicker && (
              <div className="absolute bottom-full left-0 mb-2 bg-white border-2 border-primary-200 rounded-lg shadow-2xl p-3 w-64 max-w-full max-h-48 overflow-y-auto z-50">
                <div className="grid grid-cols-8 gap-1">
                  {commonEmojis.map((emoji, index) => (
                    <button
                      key={index}
                      type="button"
                      onClick={() => insertEmoji(emoji)}
                      className="text-2xl hover:bg-primary-100 rounded p-1 transition"
                      title={emoji}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <input
            type="text"
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyDown={(e) => {
              // Send on Enter, allow Shift+Enter for new line (if we add textarea later)
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (inputMessage.trim() && isConnected) {
                  sendMessage(e as any)
                }
              }
            }}
            placeholder="Type a message and press Enter..."
            className="flex-1 bg-white text-gray-900 border border-gray-300 px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            autoFocus={typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches}
          />
          <button
            type="submit"
            disabled={!inputMessage.trim() || !isConnected}
            className="bg-primary-600 hover:bg-primary-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg transition"
            title={!isConnected ? 'Not connected' : 'Send message'}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  )
}
