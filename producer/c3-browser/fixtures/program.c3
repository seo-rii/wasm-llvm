module smoke;

extern fn int read_byte() @wasm("env", "readByte");
extern fn void write_byte(int value) @wasm("env", "writeByte");

fn int sum_squares(int count) @wasm("sum_squares")
{
	int result = 0;
	for (int i = 1; i <= count; i++) result += i * i;
	return result;
}

fn void echo() @wasm("echo")
{
	while (true)
	{
		int value = read_byte();
		if (value < 0) break;
		write_byte(value);
	}
}
