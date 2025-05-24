import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { glob } from 'glob';

// Configuración de rutas de módulos ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuración de rutas
const SLIDES_PATH = path.join(__dirname, 'documentacion', 'slides.md');
const DOCS_PATH = path.join(__dirname, 'documentacion');

// Crear la carpeta de documentación si no existe
fs.mkdir(DOCS_PATH, { recursive: true }).catch(console.error);
console.log('Ruta del archivo de presentación:', SLIDES_PATH);
console.log('Ruta de la documentación:', DOCS_PATH);

// Variables para almacenar el contenido
let slidesContent = '';
let documentationCache = [];

// Verificar archivos necesarios
async function checkFiles() {
  // Verificar archivo de presentación
  try {
    await fs.access(SLIDES_PATH);
    console.log(`Archivo de presentación encontrado en: ${SLIDES_PATH}`);
  } catch (error) {
    console.warn(`¡Advertencia! El archivo de presentación no existe en: ${SLIDES_PATH}`);
  }

  // Verificar carpeta de documentación
  try {
    await fs.access(DOCS_PATH);
    console.log(`Carpeta de documentación encontrada en: ${DOCS_PATH}`);
  } catch (error) {
    console.warn(`¡Advertencia! La carpeta de documentación no existe en: ${DOCS_PATH}`);
  }
}

// Cargar la documentación
async function loadDocumentation() {
  try {
    console.log(`Buscando archivos en: ${DOCS_PATH}`);
    const files = await glob('**/*.md', { cwd: DOCS_PATH });
    
    if (files.length === 0) {
      console.warn('No se encontraron archivos Markdown en la carpeta de documentación');
      return [];
    }
    
    const docs = [];
    
    for (const file of files) {
      try {
        const filePath = path.join(DOCS_PATH, file);
        const content = await fs.readFile(filePath, 'utf8');
        const { data: frontmatter, content: markdown } = matter(content);
        
        docs.push({
          title: frontmatter.title || path.basename(file, '.md'),
          content: markdown,
          path: file
        });
        
        console.log(`Documento cargado: ${file}`);
      } catch (fileError) {
        console.error(`Error procesando archivo ${file}:`, fileError);
      }
    }
    
    console.log(`Total de documentos cargados: ${docs.length}`);
    return docs;
  } catch (error) {
    console.error('Error cargando documentación:', error);
    return [];
  }
}

// Cargar las diapositivas
async function loadSlides() {
  try {
    await fs.access(SLIDES_PATH);
    const content = await fs.readFile(SLIDES_PATH, 'utf8');
    const { content: markdown } = matter(content);
    console.log('Presentación cargada correctamente');
    return markdown;
  } catch (error) {
    console.error('Error al cargar la presentación:', error);
    return '';
  }
}

// Inicializar la carga de datos
async function initializeData() {
  try {
    await checkFiles();
    
    // Cargar en paralelo
    const [slides, docs] = await Promise.all([
      loadSlides(),
      loadDocumentation()
    ]);
    
    slidesContent = slides || '';
    documentationCache = docs || [];
    
    console.log('Datos cargados correctamente');
    console.log(`- Longitud del contenido de las diapositivas: ${slidesContent.length} caracteres`);
    console.log(`- Número de documentos cargados: ${documentationCache.length}`);
    
  } catch (error) {
    console.error('Error al inicializar los datos:', error);
  }
}

// Iniciar la carga de datos
initializeData().catch(console.error);

// Cargar variables de entorno
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Configurar CORS
app.use(cors({
  origin: '*', // Temporalmente permitimos todos los orígenes para pruebas
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Manejar preflight requests
app.options('*', cors());

// Middleware para parsear JSON
app.use(express.json());

// Servir archivos estáticos desde la carpeta de documentación
app.use('/documentacion', express.static(DOCS_PATH, {
  setHeaders: (res, path) => {
    if (path.endsWith('.md')) {
      res.setHeader('Content-Type', 'text/markdown');
    }
  }
}));

// Inicializar el cliente de OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Ruta de prueba
app.get('/', (req, res) => {
  res.json({ message: 'API del chat de Slidev funcionando correctamente' });
});

// Función para buscar en la documentación relevante para una consulta
function searchInDocumentation(query, docs) {
  if (!query || !Array.isArray(docs) || docs.length === 0) {
    return [];
  }
  
  // Convertir la consulta a minúsculas para hacer la búsqueda insensible a mayúsculas/minúsculas
  const queryLower = query.toLowerCase();
  
  // Ordenar los documentos por relevancia (número de palabras clave coincidentes)
  const scoredDocs = docs.map(doc => {
    const content = `${doc.title} ${doc.content}`.toLowerCase();
    const words = queryLower.split(/\s+/);
    const score = words.reduce((total, word) => {
      return total + (content.includes(word) ? 1 : 0);
    }, 0);
    return { ...doc, score };
  });
  
  // Filtrar documentos con al menos una palabra clave coincidente
  const relevantDocs = scoredDocs
    .filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score);
  
  // Limitar a los 3 documentos más relevantes para no exceder el límite de tokens
  return relevantDocs.slice(0, 3);
}

// Función para limitar el tamaño del texto a un número máximo de tokens aproximado
function limitTextSize(text, maxTokens = 4000) {
  // Estimación aproximada: 1 token ≈ 4 caracteres en inglés
  const maxChars = maxTokens * 4;
  return text.length > maxChars ? text.substring(0, maxChars) + '...' : text;
}

// Ruta para enviar mensajes al chat
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Se requiere un array de mensajes' });
    }
    
    // Obtener solo los últimos 3 mensajes para mantener el contexto manejable
    const recentMessages = messages.slice(-3);
    
    // Obtener la consulta del último mensaje del usuario
    const userMessages = recentMessages.filter(m => m.role === 'user');
    const lastUserMessage = userMessages[userMessages.length - 1];
    const query = lastUserMessage?.content || '';
    
    // Limitar el tamaño del contenido de las diapositivas
    const limitedSlidesContent = limitTextSize(slidesContent, 2000);
    
    // Buscar documentación relevante
    const relevantDocs = searchInDocumentation(query, documentationCache);
    
    // Crear el contexto con la documentación relevante (limitando el tamaño)
    let docsContext = '';
    if (relevantDocs.length > 0) {
      // Limitar cada documento a aproximadamente 500 tokens
      const limitedDocs = relevantDocs.map(doc => ({
        ...doc,
        content: limitTextSize(doc.content, 500)
      }));
      
      docsContext = `\n\nDOCUMENTACIÓN ADICIONAL:\n${
        limitedDocs
          .map(doc => `--- ${doc.title} ---\n${doc.content}`)
          .join('\n\n')
      }`;
    }
    
    // Crear el mensaje del sistema con el contexto completo
    const systemMessage = {
      role: 'system',
      content: `Eres un asistente de presentaciones. Ayudas a los usuarios a entender el contenido de las presentaciones.` +
               `\n\nINSTRUCCIONES:\n` +
               `1. Responde de manera clara y concisa basándote en el contenido proporcionado.\n` +
               `2. Si la pregunta no está relacionada con el contenido disponible, indícalo amablemente.\n` +
               `3. Cuando cites información, menciona si proviene de las diapositivas o de la documentación.\n\n` +
               `CONTENIDO DE LAS DIAPOSITIVAS (resumido):\n--- INICIO ---\n${limitedSlidesContent}\n--- FIN ---` +
               docsContext
    };
    
    // Preparar los mensajes para OpenAI (sistema + mensajes recientes)
    const chatMessages = [systemMessage, ...recentMessages];
    
    // Llamar a la API de OpenAI con un modelo que soporte más contexto
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo-16k',  // Usamos la versión que soporta más tokens
      messages: chatMessages,
      temperature: 0.7,
      max_tokens: 2000  // Limitar la longitud de la respuesta
    });
    
    // Obtener la respuesta
    const response = completion.choices[0].message;
    
    // Enviar la respuesta al cliente
    res.json({
      role: 'assistant',
      content: response.content
    });
    
  } catch (error) {
    console.error('Error en la ruta /api/chat:', error);
    res.status(500).json({ 
      error: 'Error al procesar la solicitud',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Manejador de errores
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('¡Algo salió mal!');
});

// Ruta de prueba
app.get('/api/test', (req, res) => {
  res.json({ status: 'ok', message: 'El servidor está funcionando correctamente' });
});

// Manejador de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Iniciar el servidor
app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor backend ejecutándose en http://0.0.0.0:${port}`);
  console.log(`También accesible en http://localhost:${port}`);
  console.log(`CORS habilitado para todos los orígenes (solo para desarrollo)`);
});
