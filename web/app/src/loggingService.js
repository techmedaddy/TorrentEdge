// web/web-react-new/src/loggingService.js

export const logError = (error, errorInfo) => {
    // You can integrate with external logging services like Sentry, LogRocket, etc.
    console.error("Error Boundary Caught an Error:", error, errorInfo);
  };
  