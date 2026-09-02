export interface AITool {
  id: string;
  name: string;
  description: string;
  icon: string; // lucide-react icon name
}

// Coming-soon AI tools — non-functional, designed as feature previews.
export const aiTools: AITool[] = [
  {
    id: "chat",
    name: "Chat with PDF",
    description: "Ask questions about your documents.",
    icon: "MessagesSquare",
  },
  {
    id: "summarize",
    name: "Summarize PDF",
    description: "Get key points in seconds.",
    icon: "ListChecks",
  },
  {
    id: "translate",
    name: "Translate PDF",
    description: "Translate content instantly.",
    icon: "Languages",
  },
  {
    id: "explain-de",
    name: "Explain German Letters",
    description: "Understand official letters with ease.",
    icon: "FileSearch",
  },
  {
    id: "invoice-excel",
    name: "Invoice to Excel",
    description: "Extract data and export to Excel.",
    icon: "Table2",
  },
];
