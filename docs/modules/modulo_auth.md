# Especificación Técnica de Módulo: Auth (`modulo_auth`)

| Metadata | Valor |
| :--- | :--- |
| **Identificador** | `MOD-AUTH-001` |
| **Ubicación en Código** | `src/modules/auth/` |
| **Estándar** | SKL-PRO-001 (Nivel 3: Especificación en `/doc/modules/`) |
| **Versión** | 1.0.0 |

---

## 1. Responsabilidad del Módulo

Gestionar el ciclo de vida de la identidad de usuarios: registro con hashing de contraseña (Bcrypt), autenticación y emisión de tokens sin estado (JWT), y middleware interceptor para extracción del contexto de usuario (`req.user`).

---

## 2. Contratos y Firmas de la Capa

### 2.1. Router (`auth.router.ts`)
- `POST /api/v1/auth/register` -> `validate(registerSchema)` -> `authController.register`
- `POST /api/v1/auth/login` -> `validate(loginSchema)` -> `authController.login`

### 2.2. Esquemas de Validación Zod (`auth.schema.ts`)
```typescript
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('Formato de email inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  firstName: z.string().min(2, 'El nombre debe tener al menos 2 caracteres'),
  lastName: z.string().min(2, 'El apellido debe tener al menos 2 caracteres'),
  role: z.enum(['USER', 'CHEF', 'NUTRITIONIST']).optional().default('USER')
});

export const loginSchema = z.object({
  email: z.string().email('Formato de email inválido'),
  password: z.string().min(1, 'La contraseña es obligatoria')
});

export type RegisterDTO = z.infer<typeof registerSchema>;
export type LoginDTO = z.infer<typeof loginSchema>;
```

### 2.3. Servicio (`auth.service.ts`)
```typescript
export interface IAuthService {
  register(dto: RegisterDTO): Promise<{ id: string; email: string; role: string }>;
  login(dto: LoginDTO): Promise<{ token: string; user: { id: string; email: string; role: string } }>;
}
```
- **Invariantes:**
  - `register`: Comprueba si el email ya existe en `userRepository`. Si existe, lanza excepción de conflicto (`409 Conflict`). Hashea la contraseña con `bcrypt.hash(password, 10)` antes de persistir.
  - `login`: Busca usuario por email. Compara hashes con `bcrypt.compare`. Si no coincide, lanza `401 Unauthorized` genérico sin revelar si falló el email o la clave. Emite JWT firmado con expiración configurada.

### 2.4. Repositorio (`user.repository.ts`)
```typescript
export interface IUserRepository {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  create(data: Prisma.UserCreateInput): Promise<User>;
}
```
