import React, { useState, useEffect, useCallback } from "react";
import { Toolbar } from "./Toolbar";
import { ChatPanel, ChatMessage } from "./ChatPanel";
import type { Annotation, ToolbarSettings, SocketMessage, AnnotationResult } from "../types";
import { DEFAULT_TOOLBAR_SETTINGS } from "../types";

export function App() {
  const [isActive, setIsActive] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [pendingRequestId, setPendingRequestId] = useState<number | null>(null);
  const [settings, setSettings] = useState<ToolbarSettings>(DEFAULT_TOOLBAR_SETTINGS);

  // Cancel pending request when toolbar is deactivated
  useEffect(() => {
    if (!isActive && pendingRequestId !== null) {
      chrome.runtime.sendMessage({
        type: "ANNOTATIONS_COMPLETE",
        requestId: pendingRequestId,
        result: { 
          success: false, 
          annotations: [], 
          url: window.location.href, 
          viewport: { width: window.innerWidth, height: window.innerHeight }, 
          detailLevel: "standard", 
          error: "Cancelled" 
        },
      });
      setPendingRequestId(null);
    }
  }, [isActive, pendingRequestId]);

  // Listen for messages from background script
  useEffect(() => {
    const handler = (msg: SocketMessage) => {
      console.log("[pi-annotate] Content received:", msg);
      
      switch (msg.type) {
        case "START_ANNOTATION":
          // id present = tool invocation (will send ANNOTATIONS_COMPLETE)
          // id absent = command invocation (will send USER_MESSAGE)
          setPendingRequestId(msg.id ?? null);
          setAnnotations([]);  // Clear previous annotations for fresh session
          setIsActive(true);
          setShowChat(false);
          setChatMessages([]);
          break;
          
        case "TOGGLE_TOOLBAR":
          setIsActive(prev => !prev);
          break;
          
        case "AGENT_RESPONSE":
          setChatMessages(prev => [
            ...prev,
            { role: "assistant", content: msg.content }
          ]);
          break;
      }
    };
    
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // Send annotations (tool response or with chat message)
  const handleSend = useCallback((message?: string) => {
    const result: AnnotationResult = {
      success: true,
      url: window.location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      annotations,
      detailLevel: settings.outputDetail,
    };
    
    if (pendingRequestId !== null) {
      // Tool-invoked: send annotations and optionally start chat
      chrome.runtime.sendMessage({
        type: "ANNOTATIONS_COMPLETE",
        requestId: pendingRequestId,
        result,
      });
      setPendingRequestId(null);
      
      if (message) {
        // User wants to continue chatting
        // Note: Don't include annotations here - they're already in ANNOTATIONS_COMPLETE
        setShowChat(true);
        setChatMessages([{
          role: "user",
          content: message,
          annotationCount: annotations.length || undefined,
        }]);
        chrome.runtime.sendMessage({
          type: "USER_MESSAGE",
          content: message,
          url: window.location.href,
          // annotations omitted - already sent in tool result
        });
        // Clear annotations after chat starts (they're already sent)
        if (settings.autoClearAfterCopy) setAnnotations([]);
      } else {
        // Just send annotations, close
        if (settings.autoClearAfterCopy) setAnnotations([]);
        setIsActive(false);
      }
    } else if (message || annotations.length > 0) {
      // User-initiated: send annotations with optional message
      const content = message || "";
      if (message) {
        // Has message - show chat UI
        setShowChat(true);
        setChatMessages(prev => [
          ...prev,
          { role: "user", content: message, annotationCount: annotations.length || undefined }
        ]);
      } else {
        // No message - just send annotations and close
        setIsActive(false);
      }
      chrome.runtime.sendMessage({
        type: "USER_MESSAGE",
        content,
        url: window.location.href,
        annotations: annotations.length > 0 ? annotations : undefined,
      });
      if (settings.autoClearAfterCopy) setAnnotations([]);
    }
  }, [annotations, settings, pendingRequestId]);

  // Handle chat close
  const handleCloseChat = useCallback(() => {
    chrome.runtime.sendMessage({ type: "END_CHAT" });
    setShowChat(false);
    setChatMessages([]);
    setIsActive(false);
  }, []);

  // Handle toolbar close
  const handleClose = useCallback(() => {
    if (pendingRequestId !== null) {
      // Cancel tool request
      chrome.runtime.sendMessage({
        type: "ANNOTATIONS_COMPLETE",
        requestId: pendingRequestId,
        result: { 
          success: false, 
          annotations: [], 
          url: window.location.href, 
          viewport: { width: window.innerWidth, height: window.innerHeight }, 
          detailLevel: "standard", 
          error: "Cancelled" 
        },
      });
      setPendingRequestId(null);
    }
    setShowChat(false);
    setChatMessages([]);
    setIsActive(false);
  }, [pendingRequestId]);

  if (!isActive) return null;

  return (
    <>
      <Toolbar
        annotations={annotations}
        setAnnotations={setAnnotations}
        settings={settings}
        setSettings={setSettings}
        onSend={handleSend}
        onClose={handleClose}
        showChatOption={true}
      />
      
      {showChat && (
        <ChatPanel
          messages={chatMessages}
          onSend={(msg) => handleSend(msg)}
          onAnnotateMore={() => {
            // Clear current annotations so user can select new ones
            // Chat stays open, toolbar is already visible
            setAnnotations([]);
          }}
          onClose={handleCloseChat}
        />
      )}
    </>
  );
}
